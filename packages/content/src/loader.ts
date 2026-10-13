/**
 * Bundle loader (W10). Imports every authored JSON def under `data/**`, strips the editor-only
 * `$schema` key, assembles a `ContentBundle`-shaped object keyed by definition ID, computes a
 * stable hash for cache-busting (not determinism, D4/D13), and runs full validation.
 *
 * `packages/content/src` may only import `@crew/sim` as types (dependency-cruiser
 * `content-sim-types-only`), so this module never imports the kernel at runtime.
 */
import { type ValidationResult, validateBundle } from "./schemas/validate";

import deckFreighterMk1 from "../data/decks/freighter-mk1.json";
import deckFreighterMk2 from "../data/decks/freighter-mk2.json";

// Expeditions A1 (§7.2)
import machineArmsLocker from "../data/machines/arms-locker.json";
import machineBatteryBank from "../data/machines/battery-bank.json";
import machineBunk from "../data/machines/bunk.json";
import machineCaptainsChair from "../data/machines/captains-chair.json";
import machineCargoCrane from "../data/machines/cargo-crane.json";
import machineCoolantPump from "../data/machines/coolant-pump.json";
import machineDesk from "../data/machines/desk.json";
import machineEngine from "../data/machines/engine.json";
import machineEngineeringConsole from "../data/machines/engineering-console.json";
import machineExerciseRig from "../data/machines/exercise-rig.json";
import machineGalleyStove from "../data/machines/galley-stove.json";
import machineGamesTable from "../data/machines/games-table.json";
import machineGenerator from "../data/machines/generator.json";
import machineHelm from "../data/machines/helm.json";
import machineIntercom from "../data/machines/intercom.json";
import machineLifeSupport from "../data/machines/life-support.json";
import machineMedbayBed from "../data/machines/medbay-bed.json";
import machineMessTable from "../data/machines/mess-table.json";
import machineNavTerminal from "../data/machines/nav-terminal.json";
import machineOpsTerminal from "../data/machines/ops-terminal.json";
import machineVidScreen from "../data/machines/vid-screen.json";
import machineWorkbench from "../data/machines/workbench.json";

// Expeditions A1 (§7.2)
import itemBaton from "../data/items/baton.json";
import itemBlaster from "../data/items/blaster.json";
import itemBook from "../data/items/book.json";
import itemCoolantCanister from "../data/items/coolant-canister.json";
import itemCrateFragile from "../data/items/crate-fragile.json";
import itemCrateGeneral from "../data/items/crate-general.json";
import itemCrateHazardous from "../data/items/crate-hazardous.json";
import itemCratePerishable from "../data/items/crate-perishable.json";
import itemFilterCartridge from "../data/items/filter-cartridge.json";
import itemHandTruck from "../data/items/hand-truck.json";
import itemHarmonica from "../data/items/harmonica.json";
import itemHeatingElement from "../data/items/heating-element.json";
import itemHotMeal from "../data/items/hot-meal.json";
import itemHullPlating from "../data/items/hull-plating.json";
import itemMedKit from "../data/items/med-kit.json";
import itemMop from "../data/items/mop.json";
import itemOldPhotograph from "../data/items/old-photograph.json";
import itemPatchKit from "../data/items/patch-kit.json";
import itemProvisions from "../data/items/provisions.json";
import itemRationPack from "../data/items/ration-pack.json";
import itemSparePartsStack from "../data/items/spare-parts-stack.json";
import itemToolkit from "../data/items/toolkit.json";
import itemTreat from "../data/items/treat.json";
import itemWelderTorch from "../data/items/welder-torch.json";

import crewBettinaSolheim from "../data/crew/bettina-solheim.json";
import crewDaneWhitcross from "../data/crew/dane-whitcross.json";
import crewJaxOkonkwo from "../data/crew/jax-okonkwo.json";
import crewMaraOsei from "../data/crew/mara-osei.json";
import crewNoorHaddad from "../data/crew/noor-haddad.json";
import crewOyelaranAbiodun from "../data/crew/oyelaran-abiodun.json";
import crewPassenger from "../data/crew/passenger.json";
import crewPriyaKessler from "../data/crew/priya-kessler.json";
import crewSunnivaPark from "../data/crew/sunniva-park.json";
import crewTomasRuiz from "../data/crew/tomas-ruiz.json";

import traitBriskWalker from "../data/traits/brisk-walker.json";
import traitEarlyRiser from "../data/traits/early-riser.json";
import traitHeartyAppetite from "../data/traits/hearty-appetite.json";
import traitLightEater from "../data/traits/light-eater.json";
import traitLoner from "../data/traits/loner.json";
import traitMethodical from "../data/traits/methodical.json";
import traitNightOwl from "../data/traits/night-owl.json";
import traitRestless from "../data/traits/restless.json";
import traitSocialButterfly from "../data/traits/social-butterfly.json";
import traitSteady from "../data/traits/steady.json";

// Expeditions A1 (§3.1): the landing sites
import portBoathouse from "../data/ports/boathouse.json";
import portCrossroadsHub from "../data/ports/crossroads-hub.json";
import portGreenMeridian from "../data/ports/green-meridian.json";
import portHarrowEnd from "../data/ports/harrow-end.json";
import portKesslerDrift from "../data/ports/kessler-drift.json";
import portLazaret from "../data/ports/lazaret.json";
import portOssoryStation from "../data/ports/ossory-station.json";
import portTernsRest from "../data/ports/terns-rest.json";
import portVesperGate from "../data/ports/vesper-gate.json";

// Expeditions A1 (§4)
import dockBoathouse from "../data/docks/boathouse.json";
// Docks (Dockside §3)
import dockCrossroadsHub from "../data/docks/crossroads-hub.json";
import dockGreenMeridian from "../data/docks/green-meridian.json";
import dockHarrowEnd from "../data/docks/harrow-end.json";
import dockKesslerDrift from "../data/docks/kessler-drift.json";
import dockLazaret from "../data/docks/lazaret.json";
import dockOssoryStation from "../data/docks/ossory-station.json";
import dockTernsRest from "../data/docks/terns-rest.json";
import dockVesperGate from "../data/docks/vesper-gate.json";

import scenarioDefault from "../data/scenarios/default.json";

// Thoughts (§thoughts, slice 4)
import thoughtArgued from "../data/thoughts/argued.json";
import thoughtAteATreat from "../data/thoughts/ate-a-treat.json";
import thoughtAteInDirtyMess from "../data/thoughts/ate-in-dirty-mess.json";
import thoughtAteInFilthyMess from "../data/thoughts/ate-in-filthy-mess.json";
import thoughtAteRationPack from "../data/thoughts/ate-ration-pack.json";
import thoughtAteWell from "../data/thoughts/ate-well.json";
// The variety pack: thoughts from repair, the galley, mopping and a game nobody joined
import thoughtBakedForTheCrew from "../data/thoughts/baked-for-the-crew.json";
import thoughtBurntDinner from "../data/thoughts/burnt-dinner.json";
import thoughtCookedWell from "../data/thoughts/cooked-well.json";
import thoughtDoubleWatch from "../data/thoughts/double-watch.json";
import thoughtDressedDown from "../data/thoughts/dressed-down.json";
import thoughtEnjoyedMusic from "../data/thoughts/enjoyed-music.json";
import thoughtFixedIt from "../data/thoughts/fixed-it.json";
import thoughtGoodCompany from "../data/thoughts/good-company.json";
import thoughtGotLectured from "../data/thoughts/got-lectured.json";
import thoughtGrieving from "../data/thoughts/grieving.json";
import thoughtHatedTheNoise from "../data/thoughts/hated-the-noise.json";
import thoughtHeardOut from "../data/thoughts/heard-out.json";
import thoughtHeartened from "../data/thoughts/heartened.json";
// Expeditions A1 (§11)
import thoughtHeldTheLine from "../data/thoughts/held-the-line.json";
import thoughtHelmCleanPass from "../data/thoughts/helm-clean-pass.json";
import thoughtHelmScrape from "../data/thoughts/helm-scrape.json";
import thoughtKeepsBeatingMe from "../data/thoughts/keeps-beating-me.json";
import thoughtKilledSomeone from "../data/thoughts/killed-someone.json";
import thoughtLostContest from "../data/thoughts/lost-contest.json";
import thoughtNearMiss from "../data/thoughts/near-miss.json";
import thoughtNoBunkOfMyOwn from "../data/thoughts/no-bunk-of-my-own.json";
import thoughtNobodyJoinedIn from "../data/thoughts/nobody-joined-in.json";
import thoughtNoisyBunkroom from "../data/thoughts/noisy-bunkroom.json";
import thoughtOwnCabin from "../data/thoughts/own-cabin.json";
import thoughtRanFromAFight from "../data/thoughts/ran-from-a-fight.json";
import thoughtSatWithTheCaptain from "../data/thoughts/sat-with-the-captain.json";
import thoughtSawCrewHurt from "../data/thoughts/saw-crew-hurt.json";
import thoughtShaken from "../data/thoughts/shaken.json";
import thoughtSparringBruise from "../data/thoughts/sparring-bruise.json";
import thoughtSpiritedTalk from "../data/thoughts/spirited-talk.json";
import thoughtSquaredAway from "../data/thoughts/squared-away.json";
import thoughtStoodLongWatch from "../data/thoughts/stood-long-watch.json";
import thoughtWonContest from "../data/thoughts/won-contest.json";
import thoughtWorriedAbout from "../data/thoughts/worried-about.json";
import thoughtWounded from "../data/thoughts/wounded.json";

// Off watch (slice 4)
import activityBaking from "../data/activities/baking.json";
import activityBoardGame from "../data/activities/board-game.json";
import activityBookClub from "../data/activities/book-club.json";
import activityCards from "../data/activities/cards.json";
import activityDebate from "../data/activities/debate.json";
import activityExercise from "../data/activities/exercise.json";
import activityGossip from "../data/activities/gossip.json";
import activityMusic from "../data/activities/music.json";
import activityReading from "../data/activities/reading.json";
import activitySparring from "../data/activities/sparring.json";
import activityStargazing from "../data/activities/stargazing.json";
import activityTinkering from "../data/activities/tinkering.json";
import activityVideoGame from "../data/activities/video-game.json";
import activityVids from "../data/activities/vids.json";
import topicFaith from "../data/topics/faith.json";
import topicGhostShips from "../data/topics/ghost-ships.json";
import topicOldCaptains from "../data/topics/old-captains.json";
import topicPhilosophy from "../data/topics/philosophy.json";
import topicPolitics from "../data/topics/politics.json";
import topicSalvageRights from "../data/topics/salvage-rights.json";
import topicSweethearts from "../data/topics/sweethearts.json";
import topicTheGuild from "../data/topics/the-guild.json";
import topicTheLeague from "../data/topics/the-league.json";
import topicTheVid from "../data/topics/the-vid.json";

// People (§issuers-and-pitches)
import peopleNameTable from "../data/people/name-table.json";

import configDefault from "../data/config/default.json";

// The scenario names its deck; Mk1 stays as a second footprint the docks must also fit
// (§the-ships).
const DECKS = [deckFreighterMk2, deckFreighterMk1];
const MACHINES = [
  machineEngine,
  machineCoolantPump,
  machineGenerator,
  machineBatteryBank,
  machineLifeSupport,
  machineGalleyStove,
  machineBunk,
  machineMedbayBed,
  machineCargoCrane,
  machineHelm,
  machineNavTerminal,
  machineMessTable,
  machineOpsTerminal,
  machineCaptainsChair,
  machineDesk,
  machineGamesTable,
  machineVidScreen,
  machineExerciseRig,
  machineWorkbench,
  machineEngineeringConsole,
  machineIntercom,
  machineArmsLocker,
];
const ITEMS = [
  itemToolkit,
  itemWelderTorch,
  itemHandTruck,
  itemSparePartsStack,
  itemFilterCartridge,
  itemHeatingElement,
  itemCoolantCanister,
  itemRationPack,
  itemMedKit,
  itemCrateGeneral,
  itemCrateFragile,
  itemCratePerishable,
  itemCrateHazardous,
  itemHarmonica,
  itemOldPhotograph,
  itemProvisions,
  itemHotMeal,
  itemMop,
  itemBook,
  itemTreat,
  itemPatchKit,
  itemHullPlating,
  itemBlaster,
  itemBaton,
];
const CREW = [
  crewMaraOsei,
  crewDaneWhitcross,
  crewPriyaKessler,
  crewTomasRuiz,
  crewJaxOkonkwo,
  crewBettinaSolheim,
  crewOyelaranAbiodun,
  crewSunnivaPark,
  crewNoorHaddad,
  crewPassenger,
];
const TRAITS = [
  traitSteady,
  traitRestless,
  traitNightOwl,
  traitEarlyRiser,
  traitHeartyAppetite,
  traitLightEater,
  traitSocialButterfly,
  traitLoner,
  traitBriskWalker,
  traitMethodical,
];
const PORTS = [
  portCrossroadsHub,
  portKesslerDrift,
  portGreenMeridian,
  portOssoryStation,
  portVesperGate,
  portTernsRest,
  portBoathouse,
  portHarrowEnd,
  portLazaret,
];
const DOCKS = [
  dockCrossroadsHub,
  dockKesslerDrift,
  dockGreenMeridian,
  dockOssoryStation,
  dockVesperGate,
  dockTernsRest,
  dockBoathouse,
  dockHarrowEnd,
  dockLazaret,
];
const SCENARIOS = [scenarioDefault];
const THOUGHTS = [
  thoughtStoodLongWatch,
  thoughtDoubleWatch,
  thoughtHelmCleanPass,
  thoughtHelmScrape,
  thoughtAteWell,
  thoughtBurntDinner,
  thoughtAteRationPack,
  thoughtAteInDirtyMess,
  thoughtAteInFilthyMess,
  thoughtWonContest,
  thoughtLostContest,
  thoughtKeepsBeatingMe,
  thoughtGoodCompany,
  thoughtSpiritedTalk,
  thoughtArgued,
  thoughtGotLectured,
  thoughtEnjoyedMusic,
  thoughtHatedTheNoise,
  thoughtSparringBruise,
  thoughtOwnCabin,
  thoughtNoisyBunkroom,
  thoughtNoBunkOfMyOwn,
  thoughtSatWithTheCaptain,
  thoughtHeardOut,
  thoughtDressedDown,
  thoughtAteATreat,
  thoughtNearMiss,
  thoughtKilledSomeone,
  thoughtSawCrewHurt,
  thoughtHeldTheLine,
  thoughtRanFromAFight,
  thoughtWounded,
  thoughtWorriedAbout,
  thoughtGrieving,
  thoughtShaken,
  thoughtHeartened,
  thoughtFixedIt,
  thoughtCookedWell,
  thoughtBakedForTheCrew,
  thoughtNobodyJoinedIn,
  thoughtSquaredAway,
];
const ACTIVITIES = [
  activityCards,
  activityBoardGame,
  activityVids,
  activityVideoGame,
  activityDebate,
  activityExercise,
  activitySparring,
  activityReading,
  activityMusic,
  activityTinkering,
  activityStargazing,
  activityBaking,
  activityGossip,
  activityBookClub,
];
const TOPICS = [
  topicTheGuild,
  topicPolitics,
  topicFaith,
  topicPhilosophy,
  topicTheLeague,
  topicOldCaptains,
  topicTheVid,
  topicSalvageRights,
  topicGhostShips,
  topicSweethearts,
];

/** Strips the editor-only `$schema` key that authored JSON carries but the Zod schemas reject. */
function stripSchemaKey(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  const { $schema: _drop, ...rest } = value as Record<string, unknown>;
  return rest;
}

function keyById<T extends { id: string }>(defs: readonly unknown[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const raw of defs) {
    const def = stripSchemaKey(raw) as T;
    out[def.id] = def;
  }
  return out;
}

/**
 * §thoughts: thought defs are keyed by their `key` (a closed sim vocabulary), not a namespaced id.
 */
function keyByKey<T extends { key: string }>(defs: readonly unknown[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const raw of defs) {
    const def = stripSchemaKey(raw) as T;
    out[def.key] = def;
  }
  return out;
}

/**
 * Canonical JSON: object keys sorted recursively, so the hash is stable regardless of authoring
 * or import order. Not used for determinism (D4) — only cache-busting saves/build artifacts.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const out: Record<string, unknown> = {};
    for (const [key, val] of entries) {
      out[key] = canonicalize(val);
    }
    return out;
  }
  return value;
}

/**
 * FNV-1a over the canonical JSON, in pure JS so it works identically in Node (CLI/server) and the
 * browser (this package is imported by `apps/web`). Not cryptographic: this is a cache-busting
 * fingerprint (D4/D13), not a determinism guarantee.
 */
function hashOf(value: unknown): string {
  const json = JSON.stringify(canonicalize(value));
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193 ^ json.length;
  for (let i = 0; i < json.length; i += 1) {
    const c = json.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b);
  }
  h1 >>>= 0;
  h2 >>>= 0;
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/** Assembles the raw (unvalidated) bundle shape from every imported JSON def. */
export function rawBundle(): Record<string, unknown> {
  const withoutHash = {
    decks: keyById(DECKS),
    machines: keyById(MACHINES),
    items: keyById(ITEMS),
    crew: keyById(CREW),
    traits: keyById(TRAITS),
    ports: keyById(PORTS),
    scenarios: keyById(SCENARIOS),
    people: stripSchemaKey(peopleNameTable),
    docks: keyById(DOCKS),
    thoughts: keyByKey(THOUGHTS),
    activities: keyById(ACTIVITIES),
    topics: keyById(TOPICS),
    config: stripSchemaKey(configDefault),
  };
  return { ...withoutHash, hash: hashOf(withoutHash) };
}

/** Loads, validates (L1-L3) and returns the content bundle. */
export function loadBundle(): ValidationResult {
  return validateBundle(rawBundle());
}
