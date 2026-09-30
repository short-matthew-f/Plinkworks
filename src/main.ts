import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { defaultMachine, type Machine } from './model/machine';
import { decodeMachine } from './model/share';
import { initPhysics } from './sim/sim';
import { loadAutosave } from './storage/db';
import { App } from './ui/app';
import { toast } from './ui/dom';

async function boot(): Promise<void> {
  await initPhysics();
  let machine: Machine | null = null;
  const hash = location.hash.match(/^#m=([A-Za-z0-9_-]+)/);
  if (hash) {
    try {
      machine = await decodeMachine(hash[1]);
    } catch {
      toast('That share link could not be read');
    }
    history.replaceState(null, '', location.pathname + location.search);
  }
  machine ??= await loadAutosave().catch(() => null);
  const app = new App(machine ?? defaultMachine());
  (window as unknown as { plinkworks: App }).plinkworks = app; // for debugging from the console
  if (hash && machine) toast(`Opened “${app.machine.name}”`);
  registerSW({ immediate: true });
}

void boot();
