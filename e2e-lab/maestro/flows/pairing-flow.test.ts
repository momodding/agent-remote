import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const flow = readFileSync(resolve(import.meta.dir, 'pairing-flow.yaml'), 'utf8');
const pairingSheet = readFileSync(resolve(import.meta.dir, '../../../client/src/components/PairingSheet.tsx'), 'utf8');
const switchLabel = 'Skip fingerprint verification';
const switchId = 'skip-fingerprint-verification';
const initialState = `id: ${switchId}\n    checked: false`;
const tap = `tapOn:\n    id: ${switchId}`;
const selectedState = `id: ${switchId}\n    checked: true`;

assert(pairingSheet.includes(`testID="${switchId}"`), 'the pairing switch must expose a stable automation id');
assert(pairingSheet.includes(`accessibilityLabel="${switchLabel}"`), 'the pairing switch must expose an accessibility label');
assert(flow.includes(initialState), 'the pairing flow must assert the switch starts unchecked');
assert(flow.includes(tap), 'the pairing flow must tap the visible switch');
assert(flow.indexOf(selectedState) > flow.indexOf(tap), 'the pairing flow must assert the switch became checked after tapping it');
assert(!flow.includes('caller must enable'), 'the pairing flow must not require a manually pre-enabled preference');

console.log('PASS: pairing flow enables and verifies fingerprint skip');
