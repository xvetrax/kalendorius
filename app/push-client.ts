"use client";

import {clearOfflineDayPlans} from "@/lib/offline-day-plan";

export async function currentPushSubscription() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  return (await navigator.serviceWorker.ready).pushManager.getSubscription();
}

export async function pushEndpointHash(endpoint: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function logoutPushContext(all: boolean) {
  const subscription = await currentPushSubscription().catch(() => null);
  const hash = subscription ? await pushEndpointHash(subscription.endpoint).catch(() => "") : "";
  const response = await fetch(`/api/auth/logout${all ? "?all=1" : ""}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(hash ? { pushEndpointHash: hash } : {}),
  });
  if (response.ok) {
    if (subscription) await subscription.unsubscribe().catch(() => false);
    await clearOfflineDayPlans().catch(() => undefined);
  }
  return response;
}
