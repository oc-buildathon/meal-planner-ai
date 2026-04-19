import {
  Controller,
  Get,
  Header,
  Inject,
  Query,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { UsersService } from "../database/users.service";
import { validateTelegramInitData } from "./telegram-init-data";

/**
 * Endpoints that power the Telegram Mini App participant-picker:
 *
 *   GET /webapp/select-users
 *       → HTML page that uses `window.Telegram.WebApp` to render a
 *         checklist of other registered users, then posts the
 *         selection back via `tg.sendData(...)`.
 *
 *   GET /webapp/api/users?initData=...
 *       → JSON list of registered users, EXCLUDING the caller and any
 *         bots. Requires a valid Telegram `initData` signature.
 *
 * Auth model: we trust nothing except the HMAC-signed `initData`
 * handed to the Mini App by the Telegram client. Anything coming in
 * without a valid signature is rejected.
 */
@Controller("webapp")
export class WebAppController {
  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(UsersService) private readonly users: UsersService,
  ) {}

  // -----------------------------------------------------------------
  // JSON API — list users for the Mini App to render.
  // -----------------------------------------------------------------

  @Get("api/users")
  apiUsers(@Query("initData") initData: string) {
    const botToken = this.config.get<string>("telegram.botToken") ?? "";
    const check = validateTelegramInitData(initData ?? "", botToken);
    if (!check.ok) {
      return { ok: false, reason: check.reason };
    }

    const callerTgId = String(check.user.id);
    const caller = this.users.findByPlatform("telegram", callerTgId);

    const all = this.users.list(200).filter((u) => !u.is_bot);
    const others = caller
      ? all.filter((u) => u.id !== caller.id)
      : all;

    return {
      ok: true,
      callerDbId: caller?.id ?? null,
      users: others.map((u) => ({
        id: u.id,
        first_name: u.first_name,
        last_name: u.last_name,
        username: u.username,
        platform: u.platform,
        is_persona: u.is_persona === 1,
        last_seen_at: u.last_seen_at,
      })),
    };
  }

  // -----------------------------------------------------------------
  // HTML page — the Mini App itself.
  // -----------------------------------------------------------------

  @Get("select-users")
  @Header("Content-Type", "text/html; charset=utf-8")
  @HttpCode(HttpStatus.OK)
  selectUsersPage(): string {
    return MINI_APP_HTML;
  }
}

// -------------------------------------------------------------------
// Inline HTML — kept in this file so there are no static-asset
// mounts to configure. The page uses CSS variables Telegram exposes
// via `Telegram.WebApp.themeParams` so dark/light modes Just Work.
// -------------------------------------------------------------------

const MINI_APP_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <title>Pick participants</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    :root {
      --bg: var(--tg-theme-bg-color, #fff);
      --text: var(--tg-theme-text-color, #111);
      --hint: var(--tg-theme-hint-color, #888);
      --accent: var(--tg-theme-button-color, #2481cc);
      --accent-text: var(--tg-theme-button-text-color, #fff);
      --section-bg: var(--tg-theme-secondary-bg-color, #f4f4f5);
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
        "Helvetica Neue", Arial, sans-serif;
      font-size: 16px;
    }
    .wrap { padding: 16px 16px 96px; max-width: 480px; margin: 0 auto; }
    h1 { font-size: 18px; margin: 0 0 8px; }
    p.sub { color: var(--hint); margin: 0 0 16px; font-size: 14px; }
    .title-field {
      width: 100%; padding: 12px 14px; border-radius: 12px;
      border: 1px solid var(--section-bg); background: var(--section-bg);
      color: var(--text); font-size: 15px; margin-bottom: 16px;
    }
    .list {
      background: var(--section-bg);
      border-radius: 12px;
      overflow: hidden;
    }
    .empty { padding: 24px; text-align: center; color: var(--hint); }
    label.row {
      display: flex; align-items: center; gap: 12px;
      padding: 12px 14px;
      cursor: pointer; user-select: none;
      border-bottom: 1px solid rgba(0,0,0,.06);
    }
    label.row:last-child { border-bottom: 0; }
    label.row input { appearance: none; -webkit-appearance: none; width: 22px;
      height: 22px; border: 2px solid var(--hint); border-radius: 50%;
      display: inline-grid; place-content: center; flex: 0 0 auto; }
    label.row input:checked { border-color: var(--accent); }
    label.row input:checked::after {
      content: ""; width: 12px; height: 12px; border-radius: 50%;
      background: var(--accent);
    }
    .name { font-weight: 600; }
    .badge {
      display: inline-block; padding: 1px 8px; border-radius: 10px;
      background: var(--accent); color: var(--accent-text);
      font-size: 11px; font-weight: 500; margin-left: 6px;
      vertical-align: middle;
    }
    .meta { color: var(--hint); font-size: 13px; }
    .footer {
      position: fixed; left: 0; right: 0; bottom: 0;
      background: var(--bg); padding: 12px 16px calc(12px + env(safe-area-inset-bottom));
      border-top: 1px solid rgba(0,0,0,.06);
    }
    .cta {
      display: block; width: 100%;
      background: var(--accent); color: var(--accent-text);
      border: 0; border-radius: 12px; padding: 14px; font-size: 16px;
      font-weight: 600;
    }
    .cta[disabled] { opacity: .5; }
    .count { text-align: center; color: var(--hint); font-size: 13px; margin-top: 6px; }
    .error { color: #c33; padding: 12px 0; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Pick your meal-prep crew</h1>
    <p class="sub">Select who you want to plan this meal with. They'll get a DM asking what they'd like to eat.</p>

    <input id="title" class="title-field" type="text"
           placeholder="Meal name (e.g. 'Saturday dinner')" maxlength="60" />

    <div id="list" class="list">
      <div class="empty">Loading…</div>
    </div>
  </div>

  <div class="footer">
    <button id="cta" class="cta" disabled>Invite 0 people</button>
    <div class="count" id="count"></div>
  </div>

  <script>
    (function () {
      var tg = window.Telegram && window.Telegram.WebApp;
      if (!tg) {
        document.body.innerHTML =
          '<div class="wrap error">This page must be opened from inside Telegram.</div>';
        return;
      }
      tg.ready();
      tg.expand();

      var listEl = document.getElementById("list");
      var cta = document.getElementById("cta");
      var countEl = document.getElementById("count");
      var titleEl = document.getElementById("title");

      var selected = new Set();

      function updateCta() {
        var n = selected.size;
        cta.disabled = n === 0;
        cta.textContent = n === 1 ? "Invite 1 person" : "Invite " + n + " people";
      }
      updateCta();

      function initials(u) {
        return ((u.first_name || u.username || "U").charAt(0) || "U").toUpperCase();
      }

      function render(users) {
        if (users.length === 0) {
          listEl.innerHTML =
            '<div class="empty">No other users are registered yet. Ask friends to start the bot first.</div>';
          return;
        }
        listEl.innerHTML = "";
        users.forEach(function (u) {
          var row = document.createElement("label");
          row.className = "row";
          var name = [u.first_name, u.last_name].filter(Boolean).join(" ") ||
                     u.username || ("User #" + u.id);
          var handle = u.username ? " · @" + u.username : "";
          var personaBadge = u.is_persona
            ? ' <span class="badge">demo</span>'
            : "";
          row.innerHTML =
            '<input type="checkbox" value="' + u.id + '" />' +
            '<div><div class="name">' + escapeHtml(name) + personaBadge + '</div>' +
            '<div class="meta">' + escapeHtml(u.platform + handle) + '</div></div>';
          row.querySelector("input").addEventListener("change", function (e) {
            if (e.target.checked) selected.add(u.id);
            else selected.delete(u.id);
            updateCta();
          });
          listEl.appendChild(row);
        });
      }

      function escapeHtml(s) {
        return String(s || "").replace(/[&<>"']/g, function (c) {
          return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
      }

      fetch("/webapp/api/users?initData=" + encodeURIComponent(tg.initData))
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data.ok) {
            listEl.innerHTML = '<div class="empty error">Could not load users: ' +
              escapeHtml(data.reason) + '</div>';
            return;
          }
          render(data.users || []);
        })
        .catch(function (e) {
          listEl.innerHTML = '<div class="empty error">Network error: ' + escapeHtml(e.message) + '</div>';
        });

      cta.addEventListener("click", function () {
        if (selected.size === 0) return;
        var payload = {
          action: "invite_participants",
          participantIds: Array.from(selected),
          title: (titleEl.value || "").trim() || "Group meal",
        };
        tg.sendData(JSON.stringify(payload));
        tg.close();
      });
    })();
  </script>
</body>
</html>`;
