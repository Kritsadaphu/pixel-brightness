#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { NdiReceiverAdapter } from '../runtime/server/ndi-receiver-routing.mjs';
// Only read selection. Authentication may create a session, but this diagnostic
// has no select/route/restore path and never outputs credential values.
const file = process.env.PB_NDI_RECEIVER_PROFILES_FILE;
if (!file || process.argv.length !== 2) throw new Error('Set PB_NDI_RECEIVER_PROFILES_FILE to the local receiver profile file');
const data = await readFile(file);
if (data.length > 65536) throw new Error('Profile file exceeds limit');
const profiles = JSON.parse(data);
if (!Array.isArray(profiles) || !profiles.length || profiles.length > 5) throw new Error('Expected one to five profiles');
for (const p of profiles) {
  try { const current = await new NdiReceiverAdapter(p).read(); console.log(JSON.stringify({ outputId: p.outputId, reachable: true, current, switched: false })); }
  catch (e) { console.log(JSON.stringify({ outputId: p.outputId, reachable: false, error: e.message, switched: false })); process.exitCode = 1; }
}
