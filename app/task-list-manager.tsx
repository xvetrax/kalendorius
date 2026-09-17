"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";

type Source = "google" | "microsoft";
export type ManagedTaskList = {
  key: string;
  source: Source;
  account_id: string;
  list_id: string;
  name: string;
  writable: boolean;
  stale?: boolean;
  version?: string;
  can_rename?: boolean;
  can_delete?: boolean;
  management_reason?: string;
};
type Account = { source: Source; account_id: string };
type ListResponse = { lists: ManagedTaskList[]; accounts: Account[]; warnings: string[] };
type DeletePreview = { list: ManagedTaskList; task_count: number; confirmation: string | null; blocked_reason?: string };

function providerName(source: Source) { return source === "google" ? "Google Tasks" : "Microsoft To Do"; }
function errorMessage(error: unknown, fallback = "Veiksmo atlikti nepavyko.") { return error instanceof Error ? error.message : fallback; }
async function api<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Veiksmo atlikti nepavyko.");
  return data as T;
}
function accountKey(account: Account) { return `${account.source}:${account.account_id}`; }
function looksStale(message: string) { return /atnauj|pasikeit|nebeatitink|versij/i.test(message); }

export function TaskListManager({ onChanged, onDeleted, onListCreated }: {
  onChanged: () => Promise<void> | void;
  onDeleted: (key: string) => void;
  onListCreated: (key: string) => void;
}) {
  const [lists, setLists] = useState<ManagedTaskList[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [account, setAccount] = useState("");
  const [newName, setNewName] = useState("");
  const [useNewList, setUseNewList] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createNeedsRefresh, setCreateNeedsRefresh] = useState(false);
  const [renameKey, setRenameKey] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [typedName, setTypedName] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const active = useRef(true);
  const requestVersion = useRef(0);
  const busy = loading || creating || renaming || previewLoading || deleting;

  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoading(true);
    setPreview(null); setTypedName(""); setRenameKey(null);
    try {
      const result = await api<ListResponse>("/api/task-lists");
      if (!active.current || version !== requestVersion.current) return;
      setLists(result.lists);
      setAccounts(result.accounts);
      setWarnings(result.warnings);
      if (!result.warnings.length) setCreateNeedsRefresh(false);
      setAccount((current) => current && result.accounts.some((item) => accountKey(item) === current) ? current : (result.accounts[0] ? accountKey(result.accounts[0]) : ""));
      setError("");
    } catch (cause) {
      if (active.current && version === requestVersion.current) setError(errorMessage(cause, "Nepavyko įkelti užduočių sąrašų."));
    } finally {
      if (active.current && version === requestVersion.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    active.current = true;
    void refresh();
    return () => { active.current = false; requestVersion.current += 1; };
  }, [refresh]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const selected = accounts.find((item) => accountKey(item) === account);
    if (busy || createNeedsRefresh || !selected || !newName.trim()) return;
    setCreating(true); setError("");
    const version = ++requestVersion.current;
    try {
      const created = await api<ManagedTaskList>("/api/task-lists", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...selected, name: newName.trim() }) });
      if (!active.current || version !== requestVersion.current) return;
      setNewName("");
      if (useNewList) onListCreated(created.key);
      await onChanged();
      if (active.current && version === requestVersion.current) await refresh();
    } catch (cause) {
      if (active.current && version === requestVersion.current) {
        setCreateNeedsRefresh(true);
        setError(`${errorMessage(cause, "Nepavyko sukurti sąrašo.")} Prieš kartodamas kūrimą atnaujink sąrašus ir patikrink, ar sąrašas jau sukurtas.`);
      }
    } finally {
      if (active.current) setCreating(false);
    }
  }

  async function rename(event: FormEvent<HTMLFormElement>, list: ManagedTaskList) {
    event.preventDefault();
    if (busy) return;
    if (!renameName.trim() || renameName.trim() === list.name) { setRenameKey(null); return; }
    setRenaming(true); setError("");
    const version = ++requestVersion.current;
    try {
      await api<ManagedTaskList>("/api/task-lists", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: list.source, account_id: list.account_id, list_id: list.list_id, version: list.version, name: renameName.trim() }) });
      if (!active.current || version !== requestVersion.current) return;
      setRenameKey(null);
      await onChanged();
      if (active.current && version === requestVersion.current) await refresh();
    } catch (cause) {
      if (active.current && version === requestVersion.current) setError(errorMessage(cause, "Nepavyko pervadinti sąrašo."));
    } finally {
      if (active.current) setRenaming(false);
    }
  }

  async function loadPreview(list: ManagedTaskList, notice = "") {
    setPreviewLoading(true); setError(notice); setPreview(null); setTypedName(""); setRenameKey(null);
    const version = ++requestVersion.current;
    const query = new URLSearchParams({ source: list.source, account_id: list.account_id, list_id: list.list_id });
    try {
      const result = await api<DeletePreview>(`/api/task-lists?${query}`);
      if (active.current && version === requestVersion.current) setPreview(result);
    } catch (cause) {
      if (active.current && version === requestVersion.current) setError(errorMessage(cause, "Nepavyko patikrinti sąrašo prieš šalinimą."));
    } finally {
      if (active.current && version === requestVersion.current) setPreviewLoading(false);
    }
  }

  async function remove() {
    if (busy || !preview || preview.blocked_reason || !preview.confirmation || typedName !== preview.list.name) return;
    setDeleting(true); setError("");
    const deletingPreview = preview;
    const version = ++requestVersion.current;
    try {
      await api<{ ok: true }>("/api/task-lists", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: deletingPreview.list.source, account_id: deletingPreview.list.account_id, list_id: deletingPreview.list.list_id, version: deletingPreview.list.version, confirmation: deletingPreview.confirmation, confirm_name: typedName }) });
      if (!active.current || version !== requestVersion.current) return;
      onDeleted(deletingPreview.list.key);
      setPreview(null); setTypedName("");
      await onChanged();
      if (active.current && version === requestVersion.current) await refresh();
    } catch (cause) {
      const message = errorMessage(cause, "Nepavyko pašalinti sąrašo.");
      if (active.current && version === requestVersion.current) {
        setError(message);
        if (looksStale(message)) await loadPreview(deletingPreview.list, `${message} Peržiūra atnaujinta; pavadinimą įvesk iš naujo.`);
        else { setPreview(null); setTypedName(""); }
      }
    } finally {
      if (active.current) setDeleting(false);
    }
  }

  return <section className="taskListManager" aria-busy={busy || undefined}>
    <p className="formHint">Vietinės užduotys lieka vietinėje kolekcijoje — čia tvarkomi tik Google Tasks ir Microsoft To Do sąrašai.</p>
    <div className="modalActions"><button type="button" disabled={busy} onClick={() => void refresh()}>Atnaujinti sąrašus</button></div>
    {createNeedsRefresh && <p className="formHint" role="status">Kūrimą galėsi kartoti po sėkmingo sąrašų atnaujinimo.</p>}
    {error && <p className="formError" role="alert">{error}</p>}
    {warnings.map((warning) => <p className="formHint" role="status" key={warning}>{warning}</p>)}
    <form className="modalForm taskListCreate" onSubmit={create}>
      <h3>Kurti sąrašą</h3>
      <div className="formRow"><label>Paskyra<select value={account} onChange={(event) => setAccount(event.target.value)} disabled={busy || createNeedsRefresh || !accounts.length}>{accounts.length ? accounts.map((item) => <option value={accountKey(item)} key={accountKey(item)}>{providerName(item.source)}</option>) : <option>Nėra prijungtų paskyrų</option>}</select></label><label>Pavadinimas<input value={newName} onChange={(event) => setNewName(event.target.value)} required maxLength={255} disabled={busy || createNeedsRefresh || !accounts.length} placeholder="Pvz., Namų darbai"/></label></div>
      <label className="taskListChoice"><input type="checkbox" checked={useNewList} onChange={(event) => setUseNewList(event.target.checked)} disabled={busy || createNeedsRefresh || !accounts.length}/>Naudoti šį sąrašą naujoms užduotims</label>
      <div className="modalActions"><button className="newButton" disabled={busy || createNeedsRefresh || !accounts.length}>{creating ? "Kuriama…" : "Sukurti sąrašą"}</button></div>
    </form>
    <section className="taskListRows" aria-label="Prijungti užduočių sąrašai">
      <h3>Prijungti sąrašai</h3>
      {loading ? <p className="formHint" role="status">Kraunami sąrašai…</p> : !lists.length ? <p className="formHint">Prijungtose paskyrose sąrašų nerasta.</p> : lists.map((list) => {
        const mayRename = list.can_rename === true && !list.stale;
        const mayDelete = list.can_delete === true && !list.stale;
        const reason = list.management_reason || (list.stale ? "Sąrašo duomenys pasenę — atnaujink prieš tvarkydamas." : !list.writable ? "Šis sąrašas skirtas tik skaitymui." : "Šio sąrašo tvarkyti negalima.");
        return <article className="taskListRow" key={list.key}><div><strong>{list.name}</strong><small>{providerName(list.source)}</small>{(!mayRename || !mayDelete) && <small className="taskListReason">{reason}</small>}</div><div className="taskListActions"><button type="button" disabled={!mayRename || busy} onClick={() => { setRenameKey(list.key); setRenameName(list.name); setPreview(null); }}>Pervadinti</button><button type="button" className="dangerButton" disabled={!mayDelete || busy} onClick={() => void loadPreview(list)}>Šalinti</button></div>
          {renameKey === list.key && <form className="taskListInlineForm" onSubmit={(event) => void rename(event, list)}><label>Pavadinimas<input value={renameName} onChange={(event) => setRenameName(event.target.value)} required maxLength={255} disabled={busy}/></label><div><button type="button" disabled={busy} onClick={() => setRenameKey(null)}>Atšaukti</button><button className="newButton" disabled={busy}>{renaming ? "Saugoma…" : "Išsaugoti"}</button></div></form>}
        </article>;
      })}
    </section>
    {(previewLoading || preview) && <section className="taskListDelete" aria-live="polite">
      {previewLoading ? <p>Ruošiama šalinimo peržiūra…</p> : preview && <><h3>Pašalinti „{preview.list.name}“</h3>{preview.blocked_reason || !preview.confirmation ? <p className="formHint">{preview.blocked_reason || "Šios peržiūros patvirtinti negalima. Atnaujink sąrašus ir bandyk dar kartą."}</p> : <><p>Bus pašalintas sąrašas ir {preview.task_count} {preview.task_count === 1 ? "užduotis" : "užduotys"}, taip pat vietiniai jų planai.</p><label>Įrašyk „{preview.list.name}“, kad patvirtintum<input value={typedName} onChange={(event) => setTypedName(event.target.value)} disabled={busy} autoComplete="off"/></label><div className="modalActions"><button type="button" disabled={busy} onClick={() => { setPreview(null); setTypedName(""); }}>Atšaukti</button><button type="button" className="dangerButton" disabled={busy || typedName !== preview.list.name} onClick={() => void remove()}>{deleting ? "Šalinama…" : "Pašalinti sąrašą"}</button></div></>}</>}
    </section>}
  </section>;
}
