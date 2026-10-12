// Every module, in the order they run. Each one is its own file and its own
// claim; this list does not change while the world is being built.
import * as terrain from './gen/terrain.js';
import * as water from './gen/water.js';
import * as rivers from './gen/rivers.js';
import * as biomes from './gen/biomes.js';
import * as forests from './gen/forests.js';
import * as towns from './gen/towns.js';
import * as roads from './gen/roads.js';
import * as names from './gen/names.js';

export const MODULES = [terrain, water, rivers, biomes, forests, towns, roads, names];
