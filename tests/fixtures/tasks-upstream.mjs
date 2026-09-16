// Test-only provider preload. It deliberately accepts only the OAuth refresh
// endpoints and the two task APIs so a test can never contact the network.
if (process.env.TASKS_TEST_FIXTURE !== "isolated") throw new Error("Test-only preload");

const clone = value => structuredClone(value);
const microsoftSeed = () => new Map([["shared-id", {
  id: "shared-id", title: "Microsoft užduotis", status: "notStarted", importance: "high",
  body: {contentType: "text", content: "Microsoft pastaba"},
  dueDateTime: {dateTime: "2026-10-25T08:00:00.0000000", timeZone: "UTC"},
}]]);
const googleSeed = () => new Map([["shared-id", {
  id: "shared-id", title: "Google užduotis", status: "needsAction", notes: "Google pastaba",
  due: "2026-10-26T00:00:00.000Z",
}]]);

export const upstream = {
  calls: [], microsoft: microsoftSeed(), google: googleSeed(),
  reset() { this.calls.length = 0; this.microsoft = microsoftSeed(); this.google = googleSeed(); },
  writes(source) { return this.calls.filter(call => call.source === source && call.method !== "GET"); },
};

function body(init) { return init?.body ? JSON.parse(String(init.body)) : undefined; }
function taskResponse(task) { return Response.json(clone(task)); }
function taskApi(source, url, init) {
  const method = init?.method || "GET";
  const map = upstream[source];
  const prefix = source === "google" ? "/tasks/v1/lists/google-list/tasks" : "/v1.0/me/todo/lists/microsoft-list/tasks";
  upstream.calls.push({source, method, path: url.pathname + url.search, body: body(init)});
  if (url.pathname === prefix && method === "GET") return Response.json(source === "google" ? {items: [...map.values()].map(clone)} : {value: [...map.values()].map(clone)});
  if (url.pathname === prefix && method === "POST") {
    const id = `${source}-created-${map.size + 1}`;
    const created = source === "google"
      ? {id, status: "needsAction", ...body(init)}
      : {id, status: "notStarted", ...body(init)};
    map.set(id, created); return taskResponse(created);
  }
  if (!url.pathname.startsWith(prefix + "/")) return Response.json({error: "Unknown fixture endpoint"}, {status: 404});
  const id = decodeURIComponent(url.pathname.slice(prefix.length + 1));
  const task = map.get(id);
  if (!task) return Response.json({error: "Missing task"}, {status: 404});
  if (method === "PATCH") { Object.assign(task, body(init)); return taskResponse(task); }
  if (method === "DELETE") { map.delete(id); return new Response(null, {status: 204}); }
  return Response.json({error: "Unsupported fixture operation"}, {status: 405});
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.hostname === "oauth2.googleapis.com" || url.hostname === "login.microsoftonline.com") {
    return Response.json({access_token: "synthetic-access"});
  }
  if (url.hostname === "www.googleapis.com" && url.pathname === "/calendar/v3/calendars/primary/events" && !init.method) return Response.json({items:[]});
  if (url.hostname === "graph.microsoft.com" && url.pathname === "/v1.0/me/calendarView" && !init.method) return Response.json({value:[]});
  if (url.hostname === "tasks.googleapis.com") {
    if (url.pathname === "/tasks/v1/users/@me/lists") {
      upstream.calls.push({source: "google", method: init.method || "GET", path: url.pathname + url.search});
      return Response.json({items: [{id: "google-list", title: "Google darbai"}]});
    }
    return taskApi("google", url, init);
  }
  if (url.hostname === "graph.microsoft.com") {
    if (url.pathname === "/v1.0/me/todo/lists") {
      upstream.calls.push({source: "microsoft", method: init.method || "GET", path: url.pathname + url.search});
      return Response.json({value: [{id: "microsoft-list", displayName: "Microsoft darbai", wellknownListName: "defaultList"}]});
    }
    return taskApi("microsoft", url, init);
  }
  throw new Error(`Fixture blocks external network: ${url.origin}`);
};
