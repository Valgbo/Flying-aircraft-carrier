/**
 * Ground vehicle reference data (PLAN_A10.md §9 and §19): overall shapes shared by the damage
 * model and the 3D models, and public armour estimates. Owned by the TARGETS module, which adds
 * the full plate and component layout per class.
 */
import type { VehicleKind, VehicleShape } from '../core/targets/types';
import type { SourceNote } from './sources';

export const VEHICLE_SHAPES: Record<VehicleKind, VehicleShape> = {
  mbt: {
    hullLength: 6.9,
    hullWidth: 3.46,
    hullHeight: 1.25,
    hullClearance: 0.47,
    turret: { offsetZ: -0.6, radius: 1.1, height: 0.75 },
    gunLength: 6.0,
    running: { type: 'tracks', width: 0.58 },
  },
  ifv: {
    hullLength: 6.7,
    hullWidth: 2.94,
    hullHeight: 1.4,
    hullClearance: 0.42,
    turret: { offsetZ: -0.2, radius: 0.75, height: 0.5 },
    gunLength: 2.0,
    running: { type: 'tracks', width: 0.3 },
  },
  apc: {
    hullLength: 7.6,
    hullWidth: 2.9,
    hullHeight: 1.55,
    hullClearance: 0.47,
    turret: { offsetZ: -1.2, radius: 0.5, height: 0.45 },
    gunLength: 1.6,
    running: { type: 'wheels', axles: 4, radius: 0.6 },
  },
  truckCargo: {
    hullLength: 7.2,
    hullWidth: 2.5,
    hullHeight: 2.3,
    hullClearance: 0.9,
    turret: null,
    gunLength: 0,
    running: { type: 'wheels', axles: 3, radius: 0.55 },
    cabLength: 2.2,
  },
  truckFuel: {
    hullLength: 7.2,
    hullWidth: 2.5,
    hullHeight: 2.0,
    hullClearance: 0.9,
    turret: null,
    gunLength: 0,
    running: { type: 'wheels', axles: 3, radius: 0.55 },
    cabLength: 2.2,
  },
  truckAmmo: {
    hullLength: 7.2,
    hullWidth: 2.5,
    hullHeight: 2.3,
    hullClearance: 0.9,
    turret: null,
    gunLength: 0,
    running: { type: 'wheels', axles: 3, radius: 0.55 },
    cabLength: 2.2,
  },
  hulk: {
    hullLength: 6.9,
    hullWidth: 3.46,
    hullHeight: 1.25,
    hullClearance: 0.47,
    turret: { offsetZ: -0.6, radius: 1.1, height: 0.75 },
    gunLength: 4.0,
    running: { type: 'tracks', width: 0.58 },
  },
  panel: {
    hullLength: 0.3,
    hullWidth: 6.1,
    hullHeight: 6.1,
    hullClearance: 0,
    turret: null,
    gunLength: 0,
    running: { type: 'wheels', axles: 0, radius: 0 },
  },
};

/** Public armour estimates for a T-72-class tank, mm of steel (variants differ). */
export const T72_ARMOUR = {
  hullRoof: 20,
  engineDeck: 20,
  hullRear: 40,
  hullSide: 80,
  hullSideOverEngine: 70,
  turretFront: 350,
  /** Turret sides: estimates vary widely; the plan treats them as immune to the gun at range. */
  turretSide: 130,
  turretRoof: 40,
  glacis: 200,
  belly: 20,
} as const;

export const T72_ARMOUR_NOTES: Record<keyof typeof T72_ARMOUR, SourceNote> = {
  hullRoof: { source: 'tankograd', confidence: 'approximate' },
  engineDeck: { source: 'warThunderT72', confidence: 'approximate' },
  hullRear: { source: 'tankograd', confidence: 'approximate' },
  hullSide: { source: 'tankograd', confidence: 'approximate' },
  hullSideOverEngine: { source: 'tankograd', confidence: 'approximate' },
  turretFront: { source: 'tankograd', confidence: 'approximate' },
  turretSide: { source: 'tankograd', confidence: 'estimate', note: 'estimates range 130–500 mm' },
  turretRoof: { source: 'plan', confidence: 'estimate' },
  glacis: { source: 'plan', confidence: 'estimate', note: 'composite; immune to 30 mm' },
  belly: { source: 'tankograd', confidence: 'approximate' },
};
