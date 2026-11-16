/**
 * Where the reference numbers come from (PLAN_A10.md §19, docs/a10/REFERENCE_DATA.md).
 * Every constant in src/a10/data names one of these sources and a confidence.
 */

export type Confidence =
  /** Sources agree. */
  | 'confirmed'
  /** Approximate, or the sources differ: tunable. */
  | 'approximate'
  /** Our estimate or a value fitted to make public figures consistent. */
  | 'estimate';

export interface SourceNote {
  source: SourceId;
  confidence: Confidence;
  note?: string;
}

export const SOURCES = {
  gdotsGau8: {
    title: 'General Dynamics OTS, 30mm GAU-8/A Gatling gun brochure (2025)',
    url: 'https://www.gd-ots.com/wp-content/uploads/2025/06/400003355-30mm-GAU-8-A-Gatling-Gun-Product-Brochure-2025-06.pdf',
  },
  wikiGau8: {
    title: 'Wikipedia: GAU-8 Avenger',
    url: 'https://en.wikipedia.org/wiki/GAU-8_Avenger',
  },
  fasGau8: { title: 'FAS: GAU-8/A', url: 'https://man.fas.org/dod-101/sys/ac/equip/gau-8.htm' },
  aerospaceweb: {
    title: 'Aerospaceweb: A-10 Thunderbolt II',
    url: 'https://aerospaceweb.org/aircraft/attack/a10/',
  },
  aerocorner: {
    title: 'Aerocorner: A-10 Warthog',
    url: 'https://aerocorner.com/aircraft/a-10-warthog/',
  },
  wikiA10: {
    title: 'Wikipedia: Fairchild Republic A-10 Thunderbolt II',
    url: 'https://en.wikipedia.org/wiki/Fairchild_Republic_A-10_Thunderbolt_II',
  },
  flightgearA10: {
    title: 'FlightGear A-10 package (GPL v2), commit 72da115',
    url: 'https://github.com/l0k1/A-10',
  },
  flightgearFdm: {
    title: 'FlightGear wiki: A-10 Thunderbolt II FDM',
    url: 'https://wiki.flightgear.org/A-10_Thunderbolt_II_FDM',
  },
  wikiAgm65: {
    title: 'Wikipedia: AGM-65 Maverick',
    url: 'https://en.wikipedia.org/wiki/AGM-65_Maverick',
  },
  designationSystems: {
    title: 'Designation-Systems: AGM-65 Maverick',
    url: 'https://designation-systems.net/dusrm/m-65.html',
  },
  afAgm65: {
    title: 'Air & Space Forces: AGM-65 Maverick',
    url: 'https://www.airandspaceforces.com/weapons/agm-65/',
  },
  gdotsHydra: {
    title: 'General Dynamics OTS, Hydra 70 brochure (2024)',
    url: 'https://gd-ots.com/wp-content/uploads/2024/05/400003512-Hydra-70-Product-Brochure-2024-05.pdf',
  },
  wikiHydra: {
    title: 'Wikipedia / Wikiwand: Hydra 70',
    url: 'https://wikiwand.com/en/articles/Hydra_70',
  },
  wikiCbu97: {
    title: 'Wikipedia: CBU-97 Sensor Fuzed Weapon',
    url: 'https://en.wikipedia.org/wiki/CBU-97_Sensor_Fuzed_Weapon',
  },
  wikiLitening: {
    title: 'Wikipedia: AN/AAQ-28 Litening',
    url: 'https://en.wikipedia.org/wiki/AN/AAQ-28_Litening',
  },
  wikiTf34: {
    title: 'Wikipedia: General Electric TF34',
    url: 'https://en.wikipedia.org/wiki/General_Electric_TF34',
  },
  geTf34: {
    title: 'GE Aerospace TF34 datasheet',
    url: 'https://www.geaerospace.com/sites/default/files/datasheet-TF34.pdf',
  },
  tankograd: {
    title: 'Tankograd (Soviet armour blog)',
    url: 'https://thesovietarmourblog.blogspot.be/2017/',
  },
  warThunderT72: { title: 'War Thunder wiki: T-72A', url: 'https://wiki.warthunder.com/T-72A' },
  hoggitHud: { title: 'Hoggit wiki: A-10C HUD', url: 'https://wiki.hoggitworld.com/view/HUD' },
  dcsForumPac: {
    title: 'DCS forum: PAC behaviour',
    url: 'https://forum.dcs.world/topic/131382-how-do-i-know-pac-is-working',
  },
  dcsForumGunLine: {
    title: 'DCS forum: A-10C gun line',
    url: 'https://forum.dcs.world/topic/111192-where-is-the-nose-of-the-a10c-pointing',
  },
  dcsMaverick: {
    title: 'DCS A-10C wiki: Maverick procedure',
    url: 'https://wikiwiki.jp/dcsa10c/%E3%83%88%E3%83%AC%E3%83%BC%E3%83%8B%E3%83%B3%E3%82%B0/Training-Maverick',
  },
  plan: { title: 'PLAN_A10.md (this project): design decision', url: 'PLAN_A10.md' },
} as const;

export type SourceId = keyof typeof SOURCES;
