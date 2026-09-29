"use client";
/**
 * UserAccountPanel — shows current app account info, linked identities,
 * active sessions, calendar connection links, and logout/delete actions.
 *
 * Security:
 *   - All identity info fetched from /api/auth/me (server-verified session).
 *   - Logout posts to /api/auth/logout with Origin header (CSRF).
 *   - Account delete is soft-delete only; user must confirm by typing.
 */

import { useState, useEffect, useCallback } from "react";

interface Identity {
  provider: "google" | "microsoft";
  email: string | null;
}

interface MeData {
  id: number;
  displayName: string;
  email: string;
  role: "admin" | "member";
}

interface MeResponse extends MeData {
  identities?: Identity[];
  activeSessionCount?: number;
}

export function UserAccountPanel() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [activeSessionCount, setActiveSessionCount] = useState<number | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteInput, setDeleteInput] = useState("");
  const [msg, setMsg] = useState("");

  const load = useCallback(() => {
    fetch("/api/auth/me")
      .then(async (res) => {
        if (!res.ok) throw new Error("Unauthorized");
        return res.json() as Promise<MeResponse>;
      })
      .then((data) => {
        setMe(data);
        setIdentities(data.identities ?? []);
        setActiveSessionCount(data.activeSessionCount ?? null);
      })
      .catch(() => setLoadError("Nepavyko įkelti paskyros duomenų."));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function logout(all: boolean) {
    setBusy(true); setMsg("");
    try {
      const res = await fetch(`/api/auth/logout${all ? "?all=1" : ""}`, {
        method: "POST",
        headers: { "Origin": window.location.origin },
      });
      if (res.ok) {
        window.location.href = "/login";
      } else {
        setMsg("Atsijungti nepavyko. Bandyk dar kartą.");
      }
    } catch {
      setMsg("Tinklo klaida. Bandyk dar kartą.");
    } finally { setBusy(false); }
  }

  async function deleteAccount() {
    if (deleteInput !== me?.displayName) {
      setMsg("Įvestas vardas nesutampa.");
      return;
    }
    setBusy(true); setMsg("");
    try {
      const res = await fetch(`/api/admin/users/${me.id}`, {
        method: "DELETE",
        headers: { "Origin": window.location.origin },
      });
      if (res.ok) {
        window.location.href = "/login";
      } else {
        const data = await res.json().catch(() => ({}));
        setMsg(data.error ?? "Nepavyko ištrinti paskyros.");
      }
    } catch {
      setMsg("Tinklo klaida.");
    } finally { setBusy(false); }
  }

  if (loadError) {
    return <p style={{ color: "#a42d43", fontSize: ".8rem" }}>{loadError}</p>;
  }
  if (!me) {
    return <p style={{ color: "#8792a1", fontSize: ".8rem" }}>Kraunama…</p>;
  }

  return (
    <section style={{ display: "grid", gap: 14 }}>
      {/* Current user */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div className="avatar" style={{ width: 42, height: 42, fontSize: ".85rem", display: "grid", placeItems: "center" }}>
          {me.displayName.slice(0, 2).toUpperCase()}
        </div>
        <div>
          <strong style={{ fontSize: ".9rem" }}>{me.displayName}</strong>
          <small style={{ display: "block", color: "#8792a1", fontSize: ".72rem" }}>{me.email}</small>
          <small style={{ display: "block", color: "#8792a1", fontSize: ".7rem" }}>
            {me.role === "admin" ? "Administratorius" : "Narys"}
            {activeSessionCount !== null && ` · ${activeSessionCount} aktyvi sesija(-os)`}
          </small>
        </div>
      </div>

      {/* Linked identities */}
      <div>
        <p style={{ margin: "0 0 6px", fontSize: ".72rem", fontWeight: 700, color: "#8792a1", textTransform: "uppercase", letterSpacing: ".06em" }}>
          Susietos tapatybės
        </p>
        {identities.map((id, i) => (
          <div key={i} className="connection" style={{ padding: "5px 0" }}>
            <b className={id.provider === "google" ? "multi" : "blue"} style={{ width: 24, height: 24, fontSize: ".65rem" }}>
              {id.provider === "google" ? "G" : "M"}
            </b>
            <div>
              <strong style={{ fontSize: ".78rem" }}>
                {id.provider === "google" ? "Google" : "Microsoft"}
              </strong>
              {id.email && <small>{id.email}</small>}
            </div>
          </div>
        ))}
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
          {!identities.some((id) => id.provider === "google") && (
            <a href="/api/auth/google-oidc/authorize" style={{ fontSize: ".75rem", color: "#6247d8", fontWeight: 700, textDecoration: "none" }}>
              + Susieti Google paskyrą
            </a>
          )}
          {!identities.some((id) => id.provider === "microsoft") && (
            <a href="/api/auth/microsoft-oidc/authorize" style={{ fontSize: ".75rem", color: "#0078d4", fontWeight: 700, textDecoration: "none" }}>
              + Susieti Microsoft paskyrą
            </a>
          )}
        </div>
      </div>

      {/* Logout actions */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <button
          type="button"
          className="logoutBtn"
          disabled={busy}
          onClick={() => logout(false)}
        >
          Atsijungti
        </button>
        <button
          type="button"
          className="logoutBtn"
          disabled={busy}
          onClick={() => logout(true)}
          style={{ color: "#9a4d5c" }}
        >
          Atsijungti iš visų įrenginių
        </button>
      </div>

      {/* Soft delete account */}
      {!deleteConfirm ? (
        <button
          type="button"
          style={{ border: "none", background: "transparent", color: "#a42d43", fontSize: ".72rem", fontWeight: 700, cursor: "pointer", padding: "4px 0", textAlign: "left" }}
          onClick={() => { setDeleteConfirm(true); setMsg(""); }}
        >
          Ištrinti paskyrą
        </button>
      ) : (
        <div style={{ background: "#fff0f2", borderRadius: 9, padding: 14, display: "grid", gap: 8 }}>
          <p style={{ margin: 0, fontSize: ".8rem", color: "#a42d43" }}>
            Paskyra bus išjungta. Įvesk savo vardą „<strong>{me.displayName}</strong>" patvirtinimui:
          </p>
          <input
            type="text"
            value={deleteInput}
            onChange={(e) => setDeleteInput(e.target.value)}
            placeholder={me.displayName}
            style={{ border: "1px solid #f5b8c0", borderRadius: 8, padding: "8px 10px", fontSize: ".85rem" }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              disabled={busy || deleteInput !== me.displayName}
              onClick={deleteAccount}
              style={{ background: "#a42d43", color: "#fff", border: "none", borderRadius: 8, padding: "8px 14px", fontWeight: 700, cursor: "pointer", fontSize: ".8rem" }}
            >
              Ištrinti
            </button>
            <button
              type="button"
              onClick={() => { setDeleteConfirm(false); setDeleteInput(""); setMsg(""); }}
              style={{ background: "transparent", border: "1px solid #dce1e8", borderRadius: 8, padding: "8px 14px", cursor: "pointer", fontSize: ".8rem" }}
            >
              Atšaukti
            </button>
          </div>
        </div>
      )}

      {msg && <p style={{ margin: 0, fontSize: ".8rem", color: "#a42d43" }} role="alert">{msg}</p>}
    </section>
  );
}
