"use client";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { usePwaRuntime } from "@/app/pwa-runtime";

// ---------------------------------------------------------------------------
// Login form — OIDC provider choice
// ---------------------------------------------------------------------------

function LoginForm() {
  const {online}=usePwaRuntime();
  return (
    <div className="loginBox">
      <h1 className="loginTitle">Dienos planas</h1>
      <p style={{ textAlign: "center", fontSize: ".82rem", color: "#69758a", margin: "0 0 22px" }}>
        Prisijunk arba susikurk savo darbo erdvę pasirinkta paskyra.
      </p>
      <div className="loginForm" style={{ gap: 12 }}>
        <a
          href="/api/auth/google-oidc/authorize"
          aria-disabled={!online}
          onClick={event=>{if(!online)event.preventDefault();}}
          className="loginBtn"
          style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, textDecoration: "none", textAlign: "center" }}
        >
          <GoogleIcon /> Prisijungti su Google
        </a>
        <a
          href="/api/auth/microsoft-oidc/authorize"
          aria-disabled={!online}
          onClick={event=>{if(!online)event.preventDefault();}}
          className="loginBtn"
          style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, textDecoration: "none", textAlign: "center", background: "#0078d4" }}
        >
          <MicrosoftIcon /> Prisijungti su Microsoft
        </a>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Provider SVG icons (inline, no external deps)
// ---------------------------------------------------------------------------

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#fff" d="M21.8 12.2c0-.6-.1-1.3-.2-1.9H12v3.7h5.5c-.2 1.2-1 2.3-2 3v2.4h3.2c1.9-1.7 3-4.3 3-7.2z"/>
      <path fill="#fff" d="M12 22c2.7 0 4.9-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.7-5.6-4.1H3.1v2.5C4.9 19.8 8.2 22 12 22z"/>
      <path fill="#fff" d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.5H3.1A10 10 0 0 0 2 12c0 1.6.4 3.2 1.1 4.5L6.4 14z"/>
      <path fill="#fff" d="M12 5.9c1.5 0 2.8.5 3.8 1.5L18.6 4C16.9 2.4 14.7 1.5 12 1.5 8.2 1.5 4.9 3.7 3.1 7l3.3 2.5C7.2 7.7 9.4 5.9 12 5.9z"/>
    </svg>
  );
}

function MicrosoftIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="1" y="1" width="10.5" height="10.5" fill="#f25022"/>
      <rect x="12.5" y="1" width="10.5" height="10.5" fill="#7fba00"/>
      <rect x="1" y="12.5" width="10.5" height="10.5" fill="#00a4ef"/>
      <rect x="12.5" y="12.5" width="10.5" height="10.5" fill="#ffb900"/>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Page shell — checks setup status server-side equivalent via API
// ---------------------------------------------------------------------------

const LOGIN_ERRORS: Record<string, string> = {
  "signup-disabled": "Naujų paskyrų registracija šiuo metu sustabdyta.",
  "auth-failed": "Prisijungti nepavyko. Bandyk dar kartą.",
  "auth-invalid": "Netinkama autentifikacijos užklausa.",
  "auth-expired": "Autentifikacijos sesija baigėsi. Bandyk iš naujo.",
  "login-cancelled": "Prisijungimas atšauktas.",
  "account-disabled": "Paskyra išjungta. Susisiek su administratoriumi.",
};

function LoginPageInner() {
  const params = useSearchParams();
  const errorKey = params.get("error") ?? "";
  const errorMsg = LOGIN_ERRORS[errorKey] ?? "";

  return (
    <div className="loginWrap">
      {errorMsg && (
        <div style={{ maxWidth: 360, margin: "0 auto 12px", padding: "10px 14px", background: "#fff0f2", borderRadius: 10, color: "#a42d43", fontSize: ".8rem", textAlign: "center" }}>
          {errorMsg}
        </div>
      )}
      <LoginForm />
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="loginWrap"><div className="loginBox" /></div>}>
      <LoginPageInner />
    </Suspense>
  );
}
