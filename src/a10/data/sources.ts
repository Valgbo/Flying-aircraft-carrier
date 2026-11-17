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
  dcsA10Manual: {
    title:
      'Eagle Dynamics, DCS: A-10C Warthog flight manual (hobbyist simulator documentation; quotes the real flight manual)',
    url: 'https://www.digitalcombatsimulator.com/',
  },
  milF8785c: {
    title:
      'MIL-F-8785C, Military Specification: Flying Qualities of Piloted Airplanes (1980), turbulence models',
    url: 'https://everyspec.com/',
  },
  gomanKhrabrov1994: {
    title:
      'Goman & Khrabrov, State-space representation of aerodynamic characteristics of an aircraft at high angles of attack, J. Aircraft 31(5), 1994',
    url: 'https://doi.org/10.2514/3.46618',
  },
  viternaCorrigan1982: {
    title:
      'Viterna & Corrigan, Fixed pitch rotor performance of large horizontal axis wind turbines, NASA CP-2230, 1982 (post-stall model)',
    url: 'https://ntrs.nasa.gov/',
  },
  mattingly2002: {
    title: 'Mattingly, Heiser & Pratt, Aircraft Engine Design, 2nd ed., AIAA, 2002 (thrust lapse)',
    url: 'https://doi.org/10.2514/4.861444',
  },
  far25: {
    title: '14 CFR 25.103 (stall speed) and 33.73 (engine acceleration)',
    url: 'https://www.ecfr.gov/current/title-14/part-25/section-25.103',
  },
  usStandardAtmosphere1976: {
    title:
      'U.S. Standard Atmosphere, 1976 (NOAA-S/T 76-1562) and ICAO Doc 7488/3, Manual of the ICAO Standard Atmosphere',
    url: 'https://ntrs.nasa.gov/citations/19770009539',
  },
  wmoCimo: {
    title:
      'WMO-No. 8, Guide to Instruments and Methods of Observation (CIMO Guide): 10 m surface wind, Davenport–Wieringa terrain roughness classes',
    url: 'https://library.wmo.int/',
  },
  stull1988: {
    title: 'Stull, An Introduction to Boundary Layer Meteorology, Kluwer, 1988',
    url: 'https://doi.org/10.1007/978-94-009-3027-8',
  },
  icaoAnnex14: {
    title: 'ICAO Annex 14, Aerodromes, Vol. I (runway and taxiway widths)',
    url: 'https://www.icao.int/',
  },
  aashtoGreenBook: {
    title:
      'AASHTO, A Policy on Geometric Design of Highways and Streets (lane widths, maximum grades)',
    url: 'https://store.transportation.org/',
  },
  leopoldWolman1960: {
    title: 'Leopold & Wolman, River meanders, GSA Bulletin 71(6), 1960',
    url: 'https://doi.org/10.1130/0016-7606(1960)71[769:RM]2.0.CO;2',
  },
  ndiaGau8: {
    title:
      'General Dynamics OTS, 30mm GAU-8/A ammunition briefing, NDIA Gun & Missile Systems conference, 2008',
    url: 'https://ndia.dtic.mil/wp-content/uploads/2008/gun_missile/6337GimmyKirk.pdf',
  },
  aftcGau8: {
    title:
      'Air Force Test Center history: 26 Feb 1974, live firing tests of a 30mm GAU-8 cannon mounted in an A-10',
    url: 'https://www.aftc.af.mil/News/On-This-Day-in-Test-History/Article-Display-Test-History/Article/2482833/',
  },
  mccoyG7: {
    title:
      'McCoy, Modern Exterior Ballistics, Schiffer, 1999: the G7 standard drag function (US Army BRL)',
    url: 'https://search.worldcat.org/search?q=McCoy+Modern+Exterior+Ballistics',
  },
  hoernerDrag: {
    title: 'Hoerner, Fluid-Dynamic Drag, 1965, ch. 13: drag of external stores',
    url: 'https://search.worldcat.org/search?q=Hoerner+Fluid-Dynamic+Drag',
  },
  wikiMk82: { title: 'Wikipedia: Mark 82 bomb', url: 'https://en.wikipedia.org/wiki/Mark_82_bomb' },
  wikiGbu12: {
    title: 'Wikipedia: GBU-12 Paveway II',
    url: 'https://en.wikipedia.org/wiki/GBU-12_Paveway_II',
  },
  afAim9: {
    title: 'Air & Space Forces: AIM-9 Sidewinder (USAF fact sheet)',
    url: 'https://www.airandspaceforces.com/weapons/aim-9/',
  },
  arnoldLau131: {
    title: 'Arnold Defense: LAU-131/A rocket launcher data sheet',
    url: 'https://arnolddefense.com/product/lau-131-a/',
  },
  alq184Forecast: {
    title: 'Forecast International, AN Equipment Forecast (2002): AN/ALQ-184(V)',
    url: 'https://www.scribd.com/document/548921242/AN-ALQ-184',
  },
  ufc334002: {
    title:
      'UFC 3-340-02, Structures to Resist the Effects of Accidental Explosions (2008): hemispherical surface-burst blast parameters (Kingery–Bulmash)',
    url: 'https://www.wbdg.org/',
  },
  mott1947: {
    title: 'N. F. Mott, Fragmentation of shell cases, Proc. R. Soc. A 189 (1947) 300–308',
    url: 'https://doi.org/10.1098/rspa.1947.0042',
  },
  gurney1943: {
    title:
      'R. W. Gurney, The initial velocities of fragments from bombs, shells and grenades, BRL Report 405 (1943)',
    url: 'https://apps.dtic.mil/',
  },
  warThunderBmp2: { title: 'War Thunder wiki: BMP-2', url: 'https://wiki.warthunder.com/BMP-2' },
  warThunderBtr80: {
    title: 'War Thunder wiki: BTR-80A',
    url: 'https://wiki.warthunder.com/BTR-80A',
  },
  // ---- wave 2 (stores, sensors, displays, cockpit, effects) ----
  dod605509: {
    title:
      'DoD 6055.09-M, DoD Ammunition and Explosives Safety Standards: a hazardous fragment carries 58 ft-lb (79 J) or more',
    url: 'https://www.esd.whs.mil/Directives/issuances/dodm/',
  },
  ndiaHydra2003: {
    title:
      'NDIA Joint Armaments Conference 2003 (guns and missiles): US Army Hydra-70 briefing, 29 mil CEP from helicopters',
    url: 'https://ndia.dtic.mil/',
  },
  l3harrisRelease: {
    title:
      'L3Harris weapons release systems (BRU-55/A class): about 20 ft/s ejection for 500-lb stores',
    url: 'https://www.l3harris.com/',
  },
  fmu139: {
    title:
      'FMU-139 series electronic bomb fuze: short-delay settings of 10–60 ms (public summaries)',
    url: 'https://www.globalsecurity.org/',
  },
  saafLitening: {
    title:
      'South African Air Force fact page: Litening III pod (field of regard pitch +45°/−150°, roll ±400°; web summary)',
    url: 'https://www.saairforce.co.za/',
  },
  middleton1952: {
    title:
      "W. E. K. Middleton, Vision through the Atmosphere, University of Toronto Press (1952): Koschmieder's law",
    url: 'https://search.worldcat.org/search?q=Middleton+Vision+through+the+Atmosphere',
  },
  uoafCodexTgp: {
    title: 'UOAF codex: Air-to-ground TGP (A-10C targeting pod page and its cues)',
    url: 'https://codex.uoaf.net/index.php/Air-to-ground_TGP',
  },
  dcsForums: {
    title:
      'DCS World forums: A-10C threads on the TGP page cues and the cockpit model size (web summaries)',
    url: 'https://forum.dcs.world/',
  },
  didA10c: {
    title: 'Defense Industry Daily: A Higher-Tech Hog: The A-10C (two 5 × 5 in colour displays)',
    url: 'https://www.defenseindustrydaily.com/',
  },
  briggs1969: {
    title: 'G. A. Briggs, Plume Rise, USAEC Critical Review Series TID-25075 (1969)',
    url: 'https://www.osti.gov/',
  },
  turner1970: {
    title:
      'D. B. Turner, Workbook of Atmospheric Dispersion Estimates, US EPA AP-26 (1970): Pasquill–Gifford spread',
    url: 'https://nepis.epa.gov/',
  },
  vickers1996: {
    title:
      'V. E. Vickers, Plateau equalization algorithm for real-time display of high-quality infrared imagery, Optical Engineering 35(7) (1996)',
    url: 'https://www.spiedigitallibrary.org/journals/optical-engineering',
  },
  bliss1961: {
    title:
      'R. W. Bliss, Atmospheric radiation near the surface of the ground: a summary for engineers, Solar Energy 5(3) (1961)',
    url: 'https://www.sciencedirect.com/journal/solar-energy',
  },
  zuiderveld1994: {
    title:
      'K. Zuiderveld, Contrast limited adaptive histogram equalization, in Graphics Gems IV, Academic Press (1994)',
    url: 'https://www.graphicsgems.org/',
  },
  ituBt709: {
    title: 'ITU-R Recommendation BT.709: HDTV parameter values (camera transfer characteristic)',
    url: 'https://www.itu.int/rec/R-REC-BT.709',
  },
  flirCoreAgc: {
    title:
      'Teledyne FLIR thermal camera cores (Boson, Tau 2): AGC documentation, plateau equalization and ITT mean',
    url: 'https://www.flir.com/',
  },
  plan: { title: 'PLAN_A10.md (this project): design decision', url: 'PLAN_A10.md' },
} as const;

export type SourceId = keyof typeof SOURCES;
