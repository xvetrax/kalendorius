export type IconName = "calendar" | "tasks" | "focus" | "settings" | "panel" | "search" | "plus" | "sun" | "moon";
const paths:Record<IconName,string>={
  calendar:"M8 3v4m8-4v4M3 10h18M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z",
  tasks:"m4 6 2 2 4-4m3 3h7M4 14l2 2 4-4m3 3h7M4 21h16",
  focus:"M12 3a9 9 0 1 0 9 9M12 7a5 5 0 1 0 5 5m-5 0 9-9m-5 0h5v5",
  settings:"M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6m-6 0v6",
  panel:"M15 3v18M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z",
  search:"m16 16 5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
  plus:"M12 5v14M5 12h14",
  sun:"M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  moon:"M21 13a9 9 0 0 1-10-10 9 9 0 1 0 10 10Z",
};
export function Icon({name}:{name:IconName}) {return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]}/></svg>;}
