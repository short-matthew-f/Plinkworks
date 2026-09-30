// Local saves in IndexedDB: an autosave of the current machine plus named save slots.
import { normalizeMachine, type Machine } from '../model/machine';

export interface SavedMachine { id: string; name: string; updated: number; machine: Machine }

const DB = 'plinkworks';
const STORE = 'machines';
const AUTOSAVE = '__autosave__';

let dbp: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  return (dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function autosave(m: Machine): Promise<void> {
  await tx('readwrite', (s) => s.put({ id: AUTOSAVE, name: m.name, updated: Date.now(), machine: m }));
}

export async function loadAutosave(): Promise<Machine | null> {
  const r = await tx<SavedMachine | undefined>('readonly', (s) => s.get(AUTOSAVE));
  return r ? normalizeMachine(r.machine) : null;
}

export async function listSaves(): Promise<SavedMachine[]> {
  const all = await tx<SavedMachine[]>('readonly', (s) => s.getAll());
  return all.filter((r) => r.id !== AUTOSAVE).sort((a, b) => b.updated - a.updated);
}

export async function saveAs(m: Machine, id?: string): Promise<SavedMachine> {
  const rec: SavedMachine = { id: id ?? `s${Date.now().toString(36)}`, name: m.name, updated: Date.now(), machine: m };
  await tx('readwrite', (s) => s.put(rec));
  return rec;
}

export async function removeSave(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id));
}
