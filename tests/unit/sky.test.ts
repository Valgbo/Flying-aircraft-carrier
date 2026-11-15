import { Color, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  CLEAR_FOG_DENSITY,
  CLOUD_FOG_DENSITY,
  fogDensityFor,
  skyWhiteout,
  visibilityForFogDensity,
} from '../../src/scene/sky/atmosphere';
import {
  CLOUD_BASE_MAX,
  CLOUD_BASE_MIN,
  CLOUD_STRIDE,
  CLOUD_TOP_MAX,
  SPRITE_STRIDE,
  cloudCoverAt,
  createCloudLayout,
  edgeFade,
  spriteBudget,
  wrapCentered,
} from '../../src/scene/sky/cloudLayout';
import {
  SUN_CULMINATION_DEG,
  computeSkyState,
  createSkyState,
  daylightAt,
  luminance,
  moonDirectionAt,
  sunDirectionAt,
  type SkyState,
} from '../../src/scene/sky/timeOfDay';
import { acesFilmicToneMap } from '../../src/scene/sky/toneMap';
import { DEG2RAD } from '../../src/utils/math';

const COLOR_FIELDS = [
  'lightColor',
  'horizonColor',
  'zenithColor',
  'hemisphereSkyColor',
  'hemisphereGroundColor',
  'ambientColor',
  'sunDiscColor',
  'sunHaloColor',
  'horizonGlowColor',
  'moonDiscColor',
  'cloudLitColor',
  'cloudShadeColor',
] as const satisfies readonly (keyof SkyState)[];

function stateAt(hours: number): SkyState {
  return computeSkyState(hours, createSkyState());
}

function maxChannelDelta(a: Color, b: Color): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
}

describe('sun and moon geometry', () => {
  const v = new Vector3();

  it('rises due east at 06:00', () => {
    sunDirectionAt(6, v);
    expect(v.length()).toBeCloseTo(1, 6);
    expect(v.x).toBeCloseTo(1, 6);
    expect(v.y).toBeCloseTo(0, 6);
    expect(v.z).toBeCloseTo(0, 6);
  });

  it('culminates 62° above the southern horizon at noon', () => {
    sunDirectionAt(12, v);
    expect(v.length()).toBeCloseTo(1, 6);
    expect(v.x).toBeCloseTo(0, 6);
    expect(v.y).toBeCloseTo(Math.sin(SUN_CULMINATION_DEG * DEG2RAD), 6);
    expect(v.z).toBeGreaterThan(0);
    expect(SUN_CULMINATION_DEG).toBe(62);
  });

  it('sets due west at 18:00', () => {
    sunDirectionAt(18, v);
    expect(v.length()).toBeCloseTo(1, 6);
    expect(v.x).toBeCloseTo(-1, 6);
    expect(v.y).toBeCloseTo(0, 6);
  });

  it('is deep under the northern horizon at midnight', () => {
    sunDirectionAt(0, v);
    expect(v.length()).toBeCloseTo(1, 6);
    expect(v.y).toBeLessThan(-0.8);
    expect(v.z).toBeLessThan(0);
  });

  it('is in the eastern sky in the morning and the western sky in the afternoon', () => {
    expect(sunDirectionAt(9, v).x).toBeGreaterThan(0);
    expect(sunDirectionAt(9, v).y).toBeGreaterThan(0);
    expect(sunDirectionAt(15, v).x).toBeLessThan(0);
    expect(sunDirectionAt(15, v).y).toBeGreaterThan(0);
  });

  it('keeps the moon roughly opposite the sun, and up at night', () => {
    const moon = new Vector3();
    for (let h = 0; h < 24; h += 0.5) {
      sunDirectionAt(h, v);
      moonDirectionAt(h, moon);
      expect(moon.length()).toBeCloseTo(1, 6);
      expect(v.dot(moon)).toBeLessThan(-0.85);
    }
    expect(moonDirectionAt(0, moon).y).toBeGreaterThan(0.5);
    expect(moonDirectionAt(12, moon).y).toBeLessThan(-0.5);
  });
});

describe('daylight', () => {
  it('is 0 at night and 1 by day', () => {
    expect(daylightAt(0)).toBe(0);
    expect(daylightAt(3)).toBe(0);
    expect(daylightAt(9)).toBe(1);
    expect(daylightAt(12)).toBe(1);
    expect(daylightAt(16.5)).toBe(1);
    expect(daylightAt(22)).toBe(0);
    expect(daylightAt(6)).toBeCloseTo(0.5, 6);
  });

  it('rises through the morning and falls through the evening', () => {
    for (let m = 4 * 60; m < 8 * 60; m++) {
      expect(daylightAt((m + 1) / 60)).toBeGreaterThanOrEqual(daylightAt(m / 60));
    }
    for (let m = 16 * 60; m < 20 * 60; m++) {
      expect(daylightAt((m + 1) / 60)).toBeLessThanOrEqual(daylightAt(m / 60));
    }
    expect(daylightAt(6.5)).toBeGreaterThan(daylightAt(5.5));
    expect(daylightAt(18.5)).toBeLessThan(daylightAt(17.5));
  });
});

describe('sky state', () => {
  it('has finite colours within sane ranges at every half hour', () => {
    for (let h = 0; h < 24; h += 0.5) {
      const s = stateAt(h);
      for (const field of COLOR_FIELDS) {
        const c = s[field];
        const limit = field === 'sunDiscColor' ? 40 : 4;
        for (const channel of [c.r, c.g, c.b]) {
          expect(Number.isFinite(channel), `${field} at ${h}`).toBe(true);
          expect(channel, `${field} at ${h}`).toBeGreaterThanOrEqual(0);
          expect(channel, `${field} at ${h}`).toBeLessThanOrEqual(limit);
        }
      }
      expect(s.daylight).toBeGreaterThanOrEqual(0);
      expect(s.daylight).toBeLessThanOrEqual(1);
      expect(s.starVisibility).toBeGreaterThanOrEqual(0);
      expect(s.starVisibility).toBeLessThanOrEqual(1);
      expect(s.lightDirection.length()).toBeCloseTo(1, 6);
      // whatever lights the scene shines from (at most a hair below) the horizon
      if (luminance(s.lightColor) > 1e-3) expect(s.lightDirection.y).toBeGreaterThan(-0.05);
    }
  });

  it('lights the day with the sun and the night with the moon', () => {
    const noon = stateAt(12);
    expect(noon.sunIsDominant).toBe(true);
    expect(noon.lightDirection.distanceTo(noon.sunDirection)).toBe(0);
    expect(luminance(noon.lightColor)).toBeGreaterThan(1.5);
    // white-warm: red ≥ green ≥ blue, but not far apart
    expect(noon.lightColor.r).toBeGreaterThanOrEqual(noon.lightColor.g);
    expect(noon.lightColor.g).toBeGreaterThanOrEqual(noon.lightColor.b);
    expect(noon.lightColor.b / noon.lightColor.r).toBeGreaterThan(0.85);

    const golden = stateAt(17.5);
    expect(golden.lightColor.b / golden.lightColor.r).toBeLessThan(0.6);
    const sunset = stateAt(17.95);
    expect(sunset.lightColor.b / sunset.lightColor.r).toBeLessThan(0.1);
    expect(sunset.lightColor.g / sunset.lightColor.r).toBeLessThan(0.5);

    const night = stateAt(0);
    expect(night.sunIsDominant).toBe(false);
    expect(night.lightDirection.distanceTo(night.moonDirection)).toBe(0);
    expect(night.lightColor.b).toBeGreaterThan(night.lightColor.r);
    expect(luminance(night.lightColor)).toBeGreaterThan(0.1);
    expect(luminance(night.lightColor)).toBeLessThan(0.3 * luminance(noon.lightColor));
    expect(night.starVisibility).toBe(1);
    expect(noon.starVisibility).toBe(0);
  });

  it('keeps the night readable: fill light never goes black', () => {
    for (let h = 0; h < 24; h += 0.5) {
      const s = stateAt(h);
      expect(luminance(s.ambientColor) + luminance(s.hemisphereSkyColor)).toBeGreaterThan(0.3);
    }
  });

  it('wraps: 24:00 is 00:00', () => {
    const a = stateAt(0);
    const b = stateAt(24);
    const c = stateAt(-24);
    for (const field of COLOR_FIELDS) {
      expect(maxChannelDelta(a[field], b[field])).toBeLessThan(1e-9);
      expect(maxChannelDelta(a[field], c[field])).toBeLessThan(1e-9);
    }
  });
});

describe('continuity from minute to minute (including across midnight)', () => {
  const states: SkyState[] = [];
  for (let m = 0; m <= 24 * 60; m++) states.push(stateAt(m / 60));

  it('never jumps', () => {
    const worst: Record<string, number> = {};
    const note = (name: string, value: number) => {
      worst[name] = Math.max(worst[name] ?? 0, value);
    };
    for (let m = 0; m < 24 * 60; m++) {
      const a = states[m];
      const b = states[m + 1];
      note('sunDirection', a.sunDirection.distanceTo(b.sunDirection));
      note('moonDirection', a.moonDirection.distanceTo(b.moonDirection));
      note('daylight', Math.abs(a.daylight - b.daylight));
      note('starVisibility', Math.abs(a.starVisibility - b.starVisibility));
      for (const field of COLOR_FIELDS) note(field, maxChannelDelta(a[field], b[field]));
    }
    expect(worst.sunDirection).toBeLessThan(0.005);
    expect(worst.moonDirection).toBeLessThan(0.005);
    expect(worst.daylight).toBeLessThan(0.02);
    expect(worst.starVisibility).toBeLessThan(0.06);
    expect(worst.lightColor).toBeLessThan(0.15);
    expect(worst.sunDiscColor).toBeLessThan(1.5);
    for (const field of COLOR_FIELDS) {
      if (field === 'lightColor' || field === 'sunDiscColor') continue;
      expect(worst[field], field).toBeLessThan(field === 'moonDiscColor' ? 0.1 : 0.05);
    }
  });

  it('only swaps the dominant light while it is dark', () => {
    let swaps = 0;
    for (let m = 0; m < 24 * 60; m++) {
      const a = states[m];
      const b = states[m + 1];
      if (a.sunIsDominant !== b.sunIsDominant) {
        swaps++;
        expect(luminance(a.lightColor)).toBe(0);
        expect(luminance(b.lightColor)).toBe(0);
      } else {
        expect(a.lightDirection.distanceTo(b.lightDirection)).toBeLessThan(0.005);
      }
    }
    expect(swaps).toBe(2);
  });
});

describe('fog', () => {
  it('gives 25–35 km of visibility in clear air and 150–300 m inside a cloud', () => {
    expect(visibilityForFogDensity(fogDensityFor(0))).toBeGreaterThanOrEqual(25_000);
    expect(visibilityForFogDensity(fogDensityFor(0))).toBeLessThanOrEqual(35_000);
    expect(visibilityForFogDensity(fogDensityFor(1))).toBeGreaterThanOrEqual(150);
    expect(visibilityForFogDensity(fogDensityFor(1))).toBeLessThanOrEqual(300);
    expect(fogDensityFor(0)).toBeCloseTo(CLEAR_FOG_DENSITY, 12);
    expect(fogDensityFor(1)).toBeCloseTo(CLOUD_FOG_DENSITY, 12);
    expect(fogDensityFor(-1)).toBe(fogDensityFor(0));
    expect(fogDensityFor(2)).toBe(fogDensityFor(1));
  });

  it('thickens smoothly and monotonically with cloud cover', () => {
    let previousDensity = fogDensityFor(0);
    let previousWhiteout = skyWhiteout(0);
    expect(previousWhiteout).toBe(0);
    for (let i = 1; i <= 100; i++) {
      const density = fogDensityFor(i / 100);
      const whiteout = skyWhiteout(i / 100);
      expect(density).toBeGreaterThan(previousDensity);
      expect(density / previousDensity).toBeLessThan(1.06);
      expect(whiteout).toBeGreaterThanOrEqual(previousWhiteout);
      expect(whiteout - previousWhiteout).toBeLessThan(0.08);
      previousDensity = density;
      previousWhiteout = whiteout;
    }
    expect(skyWhiteout(1)).toBeGreaterThan(0.99);
  });
});

describe('cloud layout', () => {
  it('is deterministic', () => {
    const a = createCloudLayout(80);
    const b = createCloudLayout(80);
    expect(a.tileSize).toBe(b.tileSize);
    expect(a.spriteCount).toBe(b.spriteCount);
    expect(Array.from(a.clouds)).toEqual(Array.from(b.clouds));
    expect(Array.from(a.sprites)).toEqual(Array.from(b.sprites));
    const other = createCloudLayout(80, 12345);
    expect(Array.from(other.clouds)).not.toEqual(Array.from(a.clouds));
  });

  it('stays within the sprite budget for every quality preset', () => {
    for (const count of [24, 48, 80]) {
      const layout = createCloudLayout(count);
      expect(layout.cloudCount).toBe(count);
      expect(layout.spriteCount).toBeLessThanOrEqual(spriteBudget(count));
      expect(layout.spriteCount).toBeGreaterThan(count * 5);
      expect(layout.sprites.length).toBe(layout.spriteCount * SPRITE_STRIDE);
    }
    expect(createCloudLayout(80).spriteCount).toBeLessThanOrEqual(700);
    expect(createCloudLayout(24).spriteCount).toBeLessThanOrEqual(210);
  });

  it('keeps bases at 900–1300 m, tops under 2400 m and everything inside the tile', () => {
    const layout = createCloudLayout(80);
    for (let i = 0; i < layout.cloudCount; i++) {
      const o = i * CLOUD_STRIDE;
      expect(layout.clouds[o]).toBeGreaterThanOrEqual(0);
      expect(layout.clouds[o]).toBeLessThan(layout.tileSize);
      expect(layout.clouds[o + 2]).toBeGreaterThanOrEqual(0);
      expect(layout.clouds[o + 2]).toBeLessThan(layout.tileSize);
      expect(layout.clouds[o + 1]).toBeGreaterThanOrEqual(CLOUD_BASE_MIN);
      expect(layout.clouds[o + 1]).toBeLessThanOrEqual(CLOUD_BASE_MAX);
      expect(layout.clouds[o + 1] + layout.clouds[o + 4]).toBeLessThanOrEqual(CLOUD_TOP_MAX + 0.01);
    }
    for (let i = 0; i < layout.spriteCount; i++) {
      const p = i * SPRITE_STRIDE;
      const base = layout.sprites[p + 10];
      const height = 1 / layout.sprites[p + 11];
      expect(layout.sprites[p]).toBeGreaterThanOrEqual(0);
      expect(layout.sprites[p]).toBeLessThan(layout.tileSize);
      expect(layout.sprites[p + 2]).toBeGreaterThanOrEqual(0);
      expect(layout.sprites[p + 2]).toBeLessThan(layout.tileSize);
      expect(layout.sprites[p + 1]).toBeGreaterThanOrEqual(base);
      expect(layout.sprites[p + 1]).toBeLessThanOrEqual(base + height + 0.01);
      expect(layout.sprites[p + 3]).toBeGreaterThan(100);
      for (let k = 7; k <= 9; k++)
        expect(Math.abs(layout.sprites[p + k])).toBeLessThanOrEqual(1.001);
    }
  });

  it('wraps to the copy nearest the reference', () => {
    const tile = 1000;
    expect(wrapCentered(10, 0, tile)).toBe(10);
    expect(wrapCentered(990, 0, tile)).toBe(-10);
    expect(wrapCentered(10, 123_000, tile)).toBe(10);
    expect(wrapCentered(0, -499, tile)).toBe(499);
    expect(wrapCentered(0, 500, tile)).toBe(-500);
    for (let v = -3210; v < 3210; v += 37.5) {
      const d = wrapCentered(v, 77, tile);
      expect(d).toBeGreaterThanOrEqual(-500);
      expect(d).toBeLessThan(500);
      expect(Math.abs(((v - 77 - d) / tile) % 1)).toBeLessThan(1e-9);
    }
  });

  it('is continuous as the camera travels: a sprite only changes copy while it is invisible', () => {
    for (const count of [24, 80]) {
      const layout = createCloudLayout(count);
      const tile = layout.tileSize;
      const step = 40;
      for (let i = 0; i < layout.spriteCount; i += 7) {
        const p = i * SPRITE_STRIDE;
        const sx = layout.sprites[p];
        const sz = layout.sprites[p + 2];
        let previousX = -tile * 1.5 + wrapCentered(sx, -tile * 1.5, tile);
        for (let cam = -tile * 1.5 + step; cam < tile * 1.5; cam += step) {
          // camera travels along X (and, by the same amount, along Z)
          const dx = wrapCentered(sx, cam, tile);
          const dz = wrapCentered(sz, cam, tile);
          const worldX = cam + dx;
          const jump = Math.abs(worldX - previousX);
          if (jump > 1e-6) {
            expect(jump).toBeCloseTo(tile, 6);
            expect(edgeFade(Math.hypot(dx, dz), tile)).toBe(0);
            expect(edgeFade(Math.abs(dx) - step, tile)).toBe(0);
          }
          previousX = worldX;
        }
      }
      expect(edgeFade(0, tile)).toBe(1);
      expect(edgeFade(tile * 0.3, tile)).toBe(1);
      expect(edgeFade(tile * 0.5, tile)).toBe(0);
    }
  });

  it('measures how deep a point is inside cloud', () => {
    const layout = createCloudLayout(80);
    const tile = layout.tileSize;
    const x = layout.clouds[0];
    const base = layout.clouds[1];
    const z = layout.clouds[2];
    const radius = layout.clouds[3];
    const middle = base + layout.clouds[4] / 2;

    expect(cloudCoverAt(layout, x, middle, z, 0, 0)).toBe(1);
    expect(cloudCoverAt(layout, x, 5, z, 0, 0)).toBe(0);
    expect(cloudCoverAt(layout, x, 420, z, 0, 0)).toBe(0);
    expect(cloudCoverAt(layout, x, 4000, z, 0, 0)).toBe(0);
    // periodic, and carried along by the wind
    expect(cloudCoverAt(layout, x + 3 * tile, middle, z - 2 * tile, 0, 0)).toBeCloseTo(1, 6);
    expect(cloudCoverAt(layout, x + 250, middle, z - 90, 250, -90)).toBeCloseTo(1, 6);

    // continuous along a line through the cloud and out the other side
    let previous = cloudCoverAt(layout, x - 2 * radius, middle, z, 0, 0);
    let sawClear = false;
    for (let d = -2 * radius + 5; d <= 2 * radius; d += 5) {
      const cover = cloudCoverAt(layout, x + d, middle, z, 0, 0);
      expect(cover).toBeGreaterThanOrEqual(0);
      expect(cover).toBeLessThanOrEqual(1);
      expect(Math.abs(cover - previous)).toBeLessThan(0.05);
      if (cover === 0) sawClear = true;
      previous = cover;
    }
    expect(sawClear || layout.cloudCount > 1).toBe(true);
  });
});

describe('ACES tone-map copy used for the fog colour', () => {
  it('maps black to black, compresses highlights and is monotonic', () => {
    expect(acesFilmicToneMap(new Color(0, 0, 0)).r).toBe(0);
    let previous = 0;
    for (let v = 0.01; v <= 8; v += 0.01) {
      const mapped = acesFilmicToneMap(new Color(v, v, v));
      expect(mapped.r).toBeGreaterThanOrEqual(previous);
      expect(mapped.r).toBeLessThanOrEqual(1);
      // greys stay grey
      expect(Math.abs(mapped.r - mapped.g)).toBeLessThan(1e-3);
      expect(Math.abs(mapped.b - mapped.g)).toBeLessThan(1e-3);
      previous = mapped.r;
    }
    // reference values of three.js' ACESFilmicToneMapping at exposure 1
    expect(acesFilmicToneMap(new Color(0.18, 0.18, 0.18)).g).toBeCloseTo(0.213, 2);
    expect(acesFilmicToneMap(new Color(1, 1, 1)).g).toBeCloseTo(0.763, 2);
    expect(acesFilmicToneMap(new Color(16, 16, 16)).g).toBeGreaterThan(0.98);
    // exposure scales the input
    expect(acesFilmicToneMap(new Color(0.5, 0.5, 0.5), 2).g).toBeCloseTo(
      acesFilmicToneMap(new Color(1, 1, 1)).g,
      9,
    );
  });
});
