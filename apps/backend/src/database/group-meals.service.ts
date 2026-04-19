import { Injectable, Inject, Logger } from "@nestjs/common";
import { DatabaseService } from "./database.service";
import { UsersService, type UserRow } from "./users.service";

/** Row from `group_meal_requests`. */
export interface GroupMealRequestRow {
  id: number;
  initiator_id: number;
  title: string;
  prompt: string | null;
  status: "collecting" | "complete" | "cancelled";
  created_at: string;
  completed_at: string | null;
}

/** Row from `group_meal_participants`. */
export interface GroupMealParticipantRow {
  id: number;
  request_id: number;
  user_id: number;
  status: "invited" | "responded" | "declined";
  response_text: string | null;
  invited_at: string;
  responded_at: string | null;
}

export interface CreateRequestInput {
  initiatorId: number;
  title: string;
  prompt?: string | null;
  participantIds: number[];
}

/** A hydrated participant row with the user it refers to. */
export interface ParticipantWithUser {
  participant: GroupMealParticipantRow;
  user: UserRow;
}

/**
 * GroupMealsService — persists group-meal-planning sessions where one user
 * (the initiator) invites others to contribute meal preferences.
 *
 * Lifecycle of a request:
 *
 *   collecting  → (every invited participant has `responded` or `declined`)
 *   complete    → (or initiator cancels)
 *   cancelled
 *
 * The orchestrator calls `findPendingForUser()` on every incoming message
 * to decide whether that message is a response to a pending invite, or a
 * regular agent query.
 */
@Injectable()
export class GroupMealsService {
  private readonly logger = new Logger(GroupMealsService.name);

  constructor(
    @Inject(DatabaseService) private readonly dbs: DatabaseService,
    @Inject(UsersService) private readonly users: UsersService,
  ) {}

  /**
   * Create a new group-meal request and pre-create an `invited` participant
   * row for every target user. Returns the created request id.
   */
  createRequest(input: CreateRequestInput): {
    request: GroupMealRequestRow;
    participants: GroupMealParticipantRow[];
  } {
    if (input.participantIds.length === 0) {
      throw new Error("At least one participant is required");
    }

    const db = this.dbs.db;

    return db.transaction(() => {
      const request = db
        .query<GroupMealRequestRow, any>(
          `INSERT INTO group_meal_requests (initiator_id, title, prompt)
           VALUES ($iid, $title, $prompt)
           RETURNING *`,
        )
        .get({
          $iid: input.initiatorId,
          $title: input.title,
          $prompt: input.prompt ?? null,
        });

      if (!request) throw new Error("Failed to create group_meal_request");

      const insertPart = db.query<GroupMealParticipantRow, any>(
        `INSERT INTO group_meal_participants (request_id, user_id)
         VALUES ($rid, $uid)
         RETURNING *`,
      );

      const participants: GroupMealParticipantRow[] = [];
      for (const uid of input.participantIds) {
        if (uid === input.initiatorId) continue; // skip self
        try {
          const p = insertPart.get({ $rid: request.id, $uid: uid });
          if (p) participants.push(p);
        } catch (e) {
          this.logger.warn(
            `Skipping duplicate participant uid=${uid} for request ${request.id}: ${e}`,
          );
        }
      }

      return { request, participants };
    })();
  }

  /** Get a request by id. */
  findRequest(id: number): GroupMealRequestRow | null {
    return (
      this.dbs.db
        .query<GroupMealRequestRow, any>(
          `SELECT * FROM group_meal_requests WHERE id = $id`,
        )
        .get({ $id: id }) ?? null
    );
  }

  /** All participants of a request, hydrated with user rows. */
  getParticipants(requestId: number): ParticipantWithUser[] {
    const rows = this.dbs.db
      .query<GroupMealParticipantRow, any>(
        `SELECT * FROM group_meal_participants WHERE request_id = $rid
         ORDER BY id ASC`,
      )
      .all({ $rid: requestId });

    const out: ParticipantWithUser[] = [];
    for (const p of rows) {
      const u = this.users.findById(p.user_id);
      if (u) out.push({ participant: p, user: u });
    }
    return out;
  }

  /**
   * Given an incoming user, return the open (`invited`) participant row
   * if that user has an outstanding invitation — i.e. we should treat
   * their next message as a response, not a regular agent query.
   *
   * Returns the oldest pending invite first, in the rare case a user
   * is invited to multiple concurrent group meals.
   */
  findPendingForUser(userId: number): {
    request: GroupMealRequestRow;
    participant: GroupMealParticipantRow;
  } | null {
    const participant = this.dbs.db
      .query<GroupMealParticipantRow, any>(
        `SELECT gp.* FROM group_meal_participants gp
         JOIN group_meal_requests gr ON gr.id = gp.request_id
         WHERE gp.user_id = $uid
           AND gp.status = 'invited'
           AND gr.status = 'collecting'
         ORDER BY gp.id ASC
         LIMIT 1`,
      )
      .get({ $uid: userId });

    if (!participant) return null;

    const request = this.findRequest(participant.request_id);
    if (!request) return null;

    return { request, participant };
  }

  /**
   * Record a participant's response. Marks them `responded` and stamps the
   * text they sent. If this was the last pending participant, the request
   * is auto-closed to `complete`.
   *
   * Returns the updated request, *plus* the full list of
   * participants/responses so the caller can notify the initiator.
   */
  recordResponse(
    requestId: number,
    userId: number,
    responseText: string,
  ): {
    request: GroupMealRequestRow;
    participants: ParticipantWithUser[];
    allCollected: boolean;
  } {
    const db = this.dbs.db;

    return db.transaction(() => {
      db.query(
        `UPDATE group_meal_participants
         SET status = 'responded',
             response_text = $text,
             responded_at = datetime('now')
         WHERE request_id = $rid AND user_id = $uid`,
      ).run({ $rid: requestId, $uid: userId, $text: responseText });

      // Check whether any invites remain outstanding
      const pending = db
        .query<{ c: number }, any>(
          `SELECT COUNT(*) AS c FROM group_meal_participants
           WHERE request_id = $rid AND status = 'invited'`,
        )
        .get({ $rid: requestId });

      const allCollected = (pending?.c ?? 0) === 0;
      if (allCollected) {
        db.query(
          `UPDATE group_meal_requests
           SET status = 'complete', completed_at = datetime('now')
           WHERE id = $rid`,
        ).run({ $rid: requestId });
      }

      const request = this.findRequest(requestId);
      const participants = this.getParticipants(requestId);
      if (!request) {
        throw new Error(`Request ${requestId} vanished mid-transaction`);
      }
      return { request, participants, allCollected };
    })();
  }

  /**
   * Mark a participant as declining to respond. Like {@link recordResponse},
   * also auto-completes the request when it was the last outstanding invite.
   */
  recordDecline(
    requestId: number,
    userId: number,
  ): {
    request: GroupMealRequestRow;
    participants: ParticipantWithUser[];
    allCollected: boolean;
  } {
    const db = this.dbs.db;
    return db.transaction(() => {
      db.query(
        `UPDATE group_meal_participants
         SET status = 'declined',
             response_text = '(declined)',
             responded_at = datetime('now')
         WHERE request_id = $rid AND user_id = $uid`,
      ).run({ $rid: requestId, $uid: userId });

      const pending = db
        .query<{ c: number }, any>(
          `SELECT COUNT(*) AS c FROM group_meal_participants
           WHERE request_id = $rid AND status = 'invited'`,
        )
        .get({ $rid: requestId });

      const allCollected = (pending?.c ?? 0) === 0;
      if (allCollected) {
        db.query(
          `UPDATE group_meal_requests
           SET status = 'complete', completed_at = datetime('now')
           WHERE id = $rid`,
        ).run({ $rid: requestId });
      }

      const request = this.findRequest(requestId);
      const participants = this.getParticipants(requestId);
      if (!request) {
        throw new Error(`Request ${requestId} vanished mid-transaction`);
      }
      return { request, participants, allCollected };
    })();
  }

  /** Find the open request a given initiator is currently collecting for. */
  findOpenRequestForInitiator(
    initiatorId: number,
  ): GroupMealRequestRow | null {
    return (
      this.dbs.db
        .query<GroupMealRequestRow, any>(
          `SELECT * FROM group_meal_requests
           WHERE initiator_id = $iid AND status = 'collecting'
           ORDER BY id DESC LIMIT 1`,
        )
        .get({ $iid: initiatorId }) ?? null
    );
  }
}
