"use client";
/**
 * AdminPanel — admin-only user management UI.
 *
 * Features:
 *   - User list: name, email, role, status, identities, session count
 *   - Action buttons: disable/enable, promote/demote role
 *   - "Pakviesti" button — creates invite, shows shareable URL
 *   - Recovery invite per user
 *   - Active invites table with expiry and used status
 *
 * Security:
 *   - All mutations POST/PATCH/DELETE with Origin header (CSRF).
 *   - Admin role verified server-side on every request.
 *   - Admin cannot view other users' tasks, calendar data, or OAuth tokens.
 *   - Last active admin cannot be demoted or disabled (enforced server-side).
 */

import { useState, useEffect, useCallback } from "react";

interface UserEntry {
  id: number;
  displayName: string;
  email: string;
  role: "admin" | "member";
  status: "active" | "disabled";
  createdAt: string;
  lastLoginAt: string | null;
  identityCount: number;
  activeSessionCount: number;
  identities: Array<{ provider: string; email: string | null }>;
}

interface InviteEntry {
  id: number;
  recipientEmail: string | null;
  role: string;
  createdByName: string | null;
  expiresAt: string;
  usedAt: string | null;
  active: boolean;
  isRecovery: boolean;
}

interface NewInviteResult {
  inviteUrl: string;
  expiresAt: string;
  recipientEmail: string | null;
}

export function AdminPanel({ currentUserId }: { currentUserId: number }) {
  const [users, setUsers] = useState<UserEntry[]>([]);
  const [invites, setInvites] = useState<InviteEntry[]>([]);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [newInvite, setNewInvite] = useState<NewInviteResult | null>(null);
  const [recipientEmail, setRecipientEmail] = useState("");
  const [showInviteForm, setShowInviteForm] = useState(false);

  const loadAll = useCallback(async () => {
    try {
      const [usersRes, invitesRes] = await Promise.all([
        fetch("/api/admin/users"),
        fetch("/api/admin/invites"),
      ]);
      if (usersRes.ok) {
        const data = await usersRes.json() as { users: UserEntry[] };
        setUsers(data.users);
      }
      if (invitesRes.ok) {
        const data = await invitesRes.json() as { invites: InviteEntry[] };
        setInvites(data.invites);
      }
    } catch {
      setLoadError("Nepavyko įkelti naudotojų sąrašo.");
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  function flash(text: string, ok = true) {
    setMsg({ text, ok });
    setTimeout(() => setMsg(null), 5000);
  }

  async function patchUser(userId: number, patch: Record<string, unknown>) {
    const key = `patch-${userId}`;
    setBusy(key);
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "Origin": window.location.origin },
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        flash("Pakeitimas išsaugotas.");
        await loadAll();
      } else {
        flash(data.error ?? "Veiksmo atlikti nepavyko.", false);
      }
    } catch {
      flash("Tinklo klaida.", false);
    } finally { setBusy(null); }
  }

  async function createInvite() {
    setBusy("invite");
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Origin": window.location.origin },
        body: JSON.stringify({ role: "member", recipientEmail: recipientEmail.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setNewInvite({
          inviteUrl: data.inviteUrl,
          expiresAt: data.expiresAt,
          recipientEmail: data.recipientEmail,
        });
        setShowInviteForm(false);
        setRecipientEmail("");
        await loadAll();
      } else {
        flash(data.error ?? "Nepavyko sukurti kvietimo.", false);
      }
    } catch {
      flash("Tinklo klaida.", false);
    } finally { setBusy(null); }
  }

  async function createRecovery(userId: number) {
    const key = `recovery-${userId}`;
    setBusy(key);
    try {
      const res = await fetch("/api/admin/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Origin": window.location.origin },
        body: JSON.stringify({ targetUserId: userId }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setNewInvite({
          inviteUrl: data.recoveryUrl,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          recipientEmail: null,
        });
        flash("Atkūrimo nuoroda sukurta.");
      } else {
        flash(data.error ?? "Nepavyko sukurti atkūrimo nuorodos.", false);
      }
    } catch {
      flash("Tinklo klaida.", false);
    } finally { setBusy(null); }
  }

  if (loadError) {
    return <p style={{ color: "#a42d43", fontSize: ".8rem" }}>{loadError}</p>;
  }

  return (
    <section style={{ display: "grid", gap: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ margin: 0, fontSize: ".85rem", textTransform: "uppercase", letterSpacing: ".07em", color: "#8792a1" }}>
          Naudotojai
        </h3>
        <button
          type="button"
          className="newButton"
          style={{ fontSize: ".75rem", padding: "7px 12px" }}
          disabled={busy !== null}
          onClick={() => { setShowInviteForm(!showInviteForm); setNewInvite(null); }}
        >
          Pakviesti
        </button>
      </div>

      {/* Invite form */}
      {showInviteForm && (
        <div style={{ background: "#f4f2fc", borderRadius: 10, padding: 14, display: "grid", gap: 10 }}>
          <label style={{ fontSize: ".75rem", fontWeight: 700, color: "#5f6977", display: "grid", gap: 6 }}>
            Gavėjo el. paštas (neprivaloma)
            <input
              type="email"
              value={recipientEmail}
              onChange={(e) => setRecipientEmail(e.target.value)}
              placeholder="draugas@example.com"
              style={{ border: "1px solid #dce1e8", borderRadius: 8, padding: "9px 11px", fontSize: ".85rem", outline: 0 }}
            />
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="newButton"
              style={{ fontSize: ".78rem" }}
              disabled={busy === "invite"}
              onClick={createInvite}
            >
              {busy === "invite" ? "Kuriama…" : "Sukurti kvietimą"}
            </button>
            <button
              type="button"
              className="ghostButton"
              style={{ fontSize: ".78rem" }}
              onClick={() => { setShowInviteForm(false); setRecipientEmail(""); }}
            >
              Atšaukti
            </button>
          </div>
        </div>
      )}

      {/* New invite URL */}
      {newInvite && (
        <div style={{ background: "#e8f8ef", borderRadius: 10, padding: 14, display: "grid", gap: 8 }}>
          <p style={{ margin: 0, fontSize: ".78rem", fontWeight: 700, color: "#1a6b35" }}>
            Kvietimo nuoroda sukurta — perduok ją tiesiogiai:
          </p>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              readOnly
              value={newInvite.inviteUrl}
              style={{ flex: 1, border: "1px solid #b8e6cc", borderRadius: 7, padding: "7px 10px", fontSize: ".75rem", background: "#fff", color: "#1a6b35" }}
              onFocus={(e) => e.target.select()}
            />
            <button
              type="button"
              className="ghostButton"
              style={{ fontSize: ".72rem", whiteSpace: "nowrap" }}
              onClick={() => navigator.clipboard?.writeText(newInvite.inviteUrl).catch(() => {})}
            >
              Kopijuoti
            </button>
          </div>
          <small style={{ color: "#1a6b35", fontSize: ".7rem" }}>
            Galioja iki {new Date(newInvite.expiresAt).toLocaleString("lt-LT")}
          </small>
          <button
            type="button"
            style={{ background: "transparent", border: "none", color: "#8792a1", fontSize: ".7rem", cursor: "pointer", textAlign: "left", padding: 0 }}
            onClick={() => setNewInvite(null)}
          >
            Uždaryti
          </button>
        </div>
      )}

      {/* Flash message */}
      {msg && (
        <p style={{ margin: 0, fontSize: ".8rem", color: msg.ok ? "#1a6b35" : "#a42d43" }} role="alert">
          {msg.text}
        </p>
      )}

      {/* Users table */}
      <div style={{ display: "grid", gap: 8 }}>
        {users.map((user) => (
          <div
            key={user.id}
            style={{
              background: user.status === "disabled" ? "#fafbfc" : "#fff",
              border: "1px solid #e7eaf0",
              borderRadius: 11,
              padding: "12px 14px",
              display: "grid",
              gap: 8,
              opacity: user.status === "disabled" ? 0.65 : 1,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
              <div style={{ minWidth: 0 }}>
                <strong style={{ fontSize: ".85rem", display: "block" }}>
                  {user.displayName}
                  {user.id === currentUserId && (
                    <span style={{ marginLeft: 6, fontSize: ".65rem", background: "#f0edff", color: "#6247d8", borderRadius: 4, padding: "1px 5px" }}>
                      tu
                    </span>
                  )}
                </strong>
                <small style={{ color: "#8792a1", fontSize: ".72rem" }}>{user.email}</small>
                <small style={{ display: "block", color: "#8792a1", fontSize: ".68rem", marginTop: 2 }}>
                  {user.role === "admin" ? "Administratorius" : "Narys"} ·{" "}
                  {user.status === "disabled" ? "Išjungtas" : "Aktyvus"} ·{" "}
                  {user.activeSessionCount} sesija(-os) ·{" "}
                  {user.identities.map((id) => id.provider).join(", ") || "nėra tapatybių"}
                </small>
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end" }}>
                {/* Role toggle */}
                {user.id !== currentUserId && (
                  <button
                    type="button"
                    className="ghostButton"
                    style={{ fontSize: ".7rem", padding: "5px 9px" }}
                    disabled={busy !== null}
                    onClick={() => patchUser(user.id, { role: user.role === "admin" ? "member" : "admin" })}
                    title={user.role === "admin" ? "Pažeminti į narį" : "Paaukštinti į administratorių"}
                  >
                    {user.role === "admin" ? "Padaryti nariu" : "Padaryti admin"}
                  </button>
                )}
                {/* Enable/disable toggle */}
                {user.id !== currentUserId && (
                  <button
                    type="button"
                    className="ghostButton"
                    style={{ fontSize: ".7rem", padding: "5px 9px", color: user.status === "active" ? "#9a4d5c" : "#1a6b35" }}
                    disabled={busy !== null}
                    onClick={() => patchUser(user.id, { status: user.status === "active" ? "disabled" : "active" })}
                  >
                    {user.status === "active" ? "Išjungti" : "Įjungti"}
                  </button>
                )}
                {/* Recovery invite */}
                <button
                  type="button"
                  className="ghostButton"
                  style={{ fontSize: ".7rem", padding: "5px 9px" }}
                  disabled={busy !== null}
                  onClick={() => { setNewInvite(null); createRecovery(user.id); }}
                >
                  {busy === `recovery-${user.id}` ? "Kuriama…" : "Atkūrimo nuoroda"}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Invites table */}
      {invites.length > 0 && (
        <div>
          <h3 style={{ margin: "0 0 10px", fontSize: ".85rem", textTransform: "uppercase", letterSpacing: ".07em", color: "#8792a1" }}>
            Kvietimai
          </h3>
          <div style={{ display: "grid", gap: 6 }}>
            {invites.map((inv) => (
              <div
                key={inv.id}
                style={{
                  border: "1px solid #e7eaf0",
                  borderRadius: 9,
                  padding: "9px 12px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 10,
                  opacity: inv.active ? 1 : 0.5,
                  fontSize: ".75rem",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <strong style={{ fontSize: ".78rem" }}>
                    {inv.isRecovery ? "Paskyros atkūrimas" : "Kvietimas"}
                    {inv.recipientEmail && !inv.isRecovery && ` — ${inv.recipientEmail}`}
                  </strong>
                  <small style={{ display: "block", color: "#8792a1" }}>
                    Sukūrė: {inv.createdByName ?? inv.id} ·{" "}
                    Galioja iki: {new Date(inv.expiresAt).toLocaleString("lt-LT")}
                  </small>
                </div>
                <span
                  style={{
                    fontSize: ".68rem",
                    fontWeight: 700,
                    padding: "2px 7px",
                    borderRadius: 5,
                    background: inv.usedAt ? "#e8f8ef" : inv.active ? "#f0edff" : "#fafbfc",
                    color: inv.usedAt ? "#1a6b35" : inv.active ? "#6247d8" : "#8792a1",
                    flexShrink: 0,
                  }}
                >
                  {inv.usedAt ? "Panaudotas" : inv.active ? "Aktyvus" : "Pasibaigė"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
