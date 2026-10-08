"use client";
/**
 * AdminPanel — admin-only user management UI.
 *
 * Features:
 *   - User list: name, email, role, status, identities, session count
 *   - Action buttons: disable/enable, promote/demote role
 *   - Public registration happens directly through Google or Microsoft OIDC.
 *
 * Security:
 *   - All mutations POST/PATCH/DELETE with Origin header (CSRF).
 *   - Admin role verified server-side on every request.
 *   - Admin cannot view other users' tasks, calendar data, or OAuth tokens.
 *   - Last active admin cannot be demoted or disabled (enforced server-side).
 */

import { useState, useEffect, useCallback } from "react";
import {usePwaRuntime} from "@/app/pwa-runtime";

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

export function AdminPanel({ currentUserId }: { currentUserId: number }) {
  const {online}=usePwaRuntime();
  const [users, setUsers] = useState<UserEntry[]>([]);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const usersRes = await fetch("/api/admin/users");
      if (usersRes.ok) {
        const data = await usersRes.json() as { users: UserEntry[] };
        setUsers(data.users);
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
    if(!online){flash("Nėra interneto ryšio.",false);return;}
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

  if (loadError) {
    return <p style={{ color: "#a42d43", fontSize: ".8rem" }}>{loadError}</p>;
  }

  return (
    <section style={{ display: "grid", gap: 18 }}>
      <div>
        <h3 style={{ margin: 0, fontSize: ".85rem", textTransform: "uppercase", letterSpacing: ".07em", color: "#8792a1" }}>
          Naudotojai
        </h3>
        <p style={{ margin: "6px 0 0", color: "#8792a1", fontSize: ".75rem" }}>
          Nauji žmonės patys susikuria paskyrą prisijungę su Google arba Microsoft.
        </p>
      </div>

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
                    disabled={!online||busy !== null}
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
                    disabled={!online||busy !== null}
                    onClick={() => patchUser(user.id, { status: user.status === "active" ? "disabled" : "active" })}
                  >
                    {user.status === "active" ? "Išjungti" : "Įjungti"}
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

    </section>
  );
}
