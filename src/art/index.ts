/**
 * Art registry.
 *
 * Every sprite in the game is registered here and baked into a single atlas at
 * boot. Modules are split by subject so each can be iterated on independently.
 */

import type { Painter } from '../engine/atlas';
import { hedgehogPainters } from './hedgehog';
import { letterPainters } from './letters';
import { worldPainters } from './world';
import { fxPainters } from './fx';
import { uiPainters } from './ui';

export function allPainters(): Painter[] {
  return [
    ...worldPainters(),
    ...hedgehogPainters(),
    ...letterPainters(),
    ...fxPainters(),
    ...uiPainters(),
  ];
}
