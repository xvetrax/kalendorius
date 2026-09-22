"use client";
import { useState, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

function LoginForm() {
  const params = useSearchParams();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const password = ref.current?.value ?? "";
    if (!password) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        const next = params.get("next") ?? "/";
        window.location.href = next;
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Prisijungti nepavyko.");
        if (ref.current) { ref.current.value = ""; ref.current.focus(); }
      }
    } catch {
      setError("Tinklo klaida. Bandyk dar kartą.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="loginWrap">
      <div className="loginBox">
        <h1 className="loginTitle">Dienos planas</h1>
        <form onSubmit={submit} className="loginForm">
          <label htmlFor="password" className="loginLabel">Slaptažodis</label>
          <input
            id="password"
            ref={ref}
            type="password"
            autoFocus
            autoComplete="current-password"
            className="loginInput"
            placeholder="Įveskite slaptažodį"
            disabled={busy}
          />
          {error && <p className="loginError" role="alert">{error}</p>}
          <button type="submit" className="loginBtn" disabled={busy}>
            {busy ? "Jungiamasi…" : "Prisijungti"}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
