import { describe, expect, it } from 'vitest';
import {
  DelayQueue,
  ImpactAggregator,
  SimAudioClock,
  SourceHistory,
  absorptionCutoff,
  arrivalTime,
  crackDelay,
  crackGain,
  createSourceSample,
  distanceGain,
  dopplerFactor,
  propagationDelay,
  soundSpeed,
  type MovingPoint,
} from '../../../src/a10/audio/propagation';
import { speedOfSoundAt } from '../../../src/a10/core/world';

const C0 = speedOfSoundAt(0);
const still = (x: number, y: number, z: number): MovingPoint => ({ x, y, z, vx: 0, vy: 0, vz: 0 });

describe('propagation', () => {
  it('sound takes distance / c, with c of the path (ISA at the mean height)', () => {
    expect(C0).toBeCloseTo(340.29, 1);
    expect(propagationDelay(1200, C0)).toBeCloseTo(1200 / 340.29, 3);
    expect(soundSpeed(0, 2000)).toBeCloseTo(speedOfSoundAt(1000), 9);
    // a high path is slower: 3 % at 5,000 m
    expect(soundSpeed(5000, 5000)).toBeLessThan(C0 * 0.97);
    for (const bad of [NaN, Infinity, -1])
      expect(Number.isFinite(propagationDelay(bad, C0))).toBe(true);
    expect(Number.isFinite(soundSpeed(NaN, 1e9))).toBe(true);
  });

  it('air absorption darkens with range and keeps darkening beyond 2 km', () => {
    const d = [10, 50, 100, 300, 1000, 2000, 5000, 10000, 30000];
    const f = d.map(absorptionCutoff);
    for (let i = 1; i < f.length; i++) expect(f[i]).toBeLessThanOrEqual(f[i - 1]);
    expect(f[2]).toBeCloseTo(6760, -2); // 100 m: the 6 dB point
    expect(f[4]).toBeCloseTo(1150, -2); // 1 km
    expect(f[6]).toBeLessThan(400); // 5 km: a dull rumble
    expect(f[5]).toBeLessThan(f[4] * 0.7); // no floor at 2 km (the carrier's mapping had one)
    expect(absorptionCutoff(0)).toBe(18000);
    expect(absorptionCutoff(1e9)).toBe(120);
    expect(absorptionCutoff(NaN)).toBe(18000);
  });

  it('spreading loss from a per-source reference level', () => {
    expect(distanceGain(5, 10)).toBe(1);
    expect(distanceGain(20, 10)).toBeCloseTo(0.5, 12);
    expect(distanceGain(1000, 100)).toBeCloseTo(0.1, 12);
    // a softened rolloff loses −3.9 dB per doubling instead of −6
    expect(20 * Math.log10(distanceGain(30, 15, 0.65))).toBeCloseTo(-3.91, 2);
    expect(distanceGain(NaN, 10)).toBe(1);
    expect(distanceGain(100, NaN)).toBeGreaterThan(0);
  });

  it('a sound reaches a listener sooner when they move toward it, later when away', () => {
    const e = { x: 0, y: 0, z: -1000 };
    const t0 = arrivalTime(0, e, 0, still(0, 0, 0), 340);
    expect(t0).toBeCloseTo(1000 / 340, 9);
    const toward = arrivalTime(0, e, 0, { ...still(0, 0, 0), vz: -100 }, 340);
    const away = arrivalTime(0, e, 0, { ...still(0, 0, 0), vz: 100 }, 340);
    expect(toward).toBeCloseTo(1000 / 440, 9);
    expect(away).toBeCloseTo(1000 / 240, 9);
    // already passed: the time it passed the listener's position (≤ now)
    expect(arrivalTime(0, e, 5, still(0, 0, 0), 340)).toBeCloseTo(1000 / 340, 9);
    // a camera cut (absurd speed) is not motion
    expect(arrivalTime(0, e, 0, { ...still(0, 0, 0), vz: -5000 }, 340)).toBeCloseTo(t0, 9);
    // the prediction made mid-flight agrees with the closed form for a moving listener
    const mid = arrivalTime(0, e, 1, { ...still(0, 0, -100), vz: -100 }, 340);
    expect(mid).toBeCloseTo(1000 / 440, 9);
  });

  it('Doppler: a fly-by is high coming in, low going away, unchanged abeam', () => {
    const lis = still(0, 0, 0);
    const coming = { ...still(0, 0, -500), vz: 150 };
    const going = { ...still(0, 0, 500), vz: 150 };
    const abeam = { ...still(500, 0, 0), vz: 150 };
    expect(dopplerFactor(coming, lis, 340)).toBeCloseTo(340 / 190, 9);
    expect(dopplerFactor(going, lis, 340)).toBeCloseTo(340 / 490, 9);
    expect(dopplerFactor(abeam, lis, 340)).toBeCloseTo(1, 9);
    expect(dopplerFactor({ ...still(0, 0, -10), vz: 1e6 }, lis, 340)).toBeLessThanOrEqual(2);
  });

  it('the crack of a supersonic round arrives b·cos μ / c after it is abeam', () => {
    expect(crackDelay(0, 900, 340)).toBe(0);
    const mu = Math.asin(340 / 900);
    expect(crackDelay(10, 900, 340)).toBeCloseTo((10 * Math.cos(mu)) / 340, 12);
    // between 0 (sonic) and b/c (very fast)
    expect(crackDelay(10, 341, 340)).toBeLessThan(0.003);
    expect(crackDelay(10, 1e6, 340)).toBeCloseTo(10 / 340, 6);
    expect(crackDelay(10, 300, 340)).toBeNaN();
    expect(crackGain(5)).toBeCloseTo(1, 12);
    expect(crackGain(50)).toBeCloseTo(Math.pow(0.1, 0.75), 12);
    expect(crackGain(0)).toBe(1.5);
  });
});

describe('sim time → audio time', () => {
  it("maps a frame's events to the future at their exact spacing", () => {
    const clock = new SimAudioClock(0.03);
    // frame: the sim went from 10.000 to 10.0167 s; the audio clock reads 2.000 s
    clock.update(10 + 1 / 60, 1 / 60, 2);
    const a = clock.toAudio(10.004, 2);
    const b = clock.toAudio(10.012, 2);
    expect(a).toBeCloseTo(2.034, 9);
    expect(b - a).toBeCloseTo(0.008, 9);
    expect(a).toBeGreaterThan(2);
    // never earlier than now
    expect(clock.toAudio(9, 2)).toBe(2);
  });

  it('smooths frame jitter and re-synchronises after a pause', () => {
    const clock = new SimAudioClock(0.03, 0.05, 0.2);
    let audio = 0;
    let sim = 0;
    for (let f = 0; f < 120; f++) {
      audio += 1 / 60 + (f % 2 ? 0.002 : -0.002); // jittery frames
      sim += 1 / 60;
      clock.update(sim, 1 / 60, audio);
    }
    const before = clock.offset;
    // paused for 3 s: sim time stands still, frames do not advance it
    for (let f = 0; f < 180; f++) {
      audio += 1 / 60;
      clock.update(sim, 0, audio);
    }
    expect(clock.offset).toBe(before);
    // resume: the mapping jumps to the new audio time at once
    audio += 1 / 60;
    sim += 1 / 60;
    clock.update(sim, 1 / 60, audio);
    expect(clock.offset - before).toBeCloseTo(3, 1);
    expect(clock.toAudio(sim, audio)).toBeGreaterThan(audio);
  });

  it('gun scheduling: a burst from 0.5 s to 2.5 s keeps its 2 s length on the audio clock', () => {
    const clock = new SimAudioClock();
    let audio = 7.3;
    let start = NaN;
    let stop = NaN;
    for (let f = 1; f <= 360; f++) {
      const t1 = f / 120;
      audio += 1 / 120;
      clock.update(t1, 1 / 120, audio);
      if (t1 >= 0.5 && Number.isNaN(start)) start = clock.toAudio(0.5, audio);
      if (t1 >= 2.5 && Number.isNaN(stop)) stop = clock.toAudio(2.5, audio);
    }
    expect(stop - start).toBeCloseTo(2, 3);
    // and starts a lookahead after the audio time of the frame it was reported in
    expect(start - (7.3 + 0.5)).toBeGreaterThan(0);
    expect(start - (7.3 + 0.5)).toBeLessThan(0.05);
  });
});

describe('delayed sounds wait in sim time', () => {
  it('a sound 680 m away arrives after 2 s, and a pause holds it in flight', () => {
    const q = new DelayQueue<string>();
    q.push(0, 0, 0, -680, 'boom');
    const lis = still(0, 0, 0);
    const c = soundSpeed(0, 0);
    const got: [string, number][] = [];
    const due = (item: { payload: string }, at: number) => got.push([item.payload, at]);
    for (let t = 0; t < 1.5; t += 1 / 60) q.release(t, 0.1, lis, due);
    expect(got).toEqual([]);
    // paused at 1.5 s for a long time: sim time does not move, nothing is released
    for (let f = 0; f < 1000; f++) q.release(1.5, 0.1, lis, due);
    expect(got).toEqual([]);
    expect(q.length).toBe(1);
    // resumed: released once its arrival is within the horizon, with the exact arrival time
    let t = 1.5;
    while (!got.length && t < 3) {
      t += 1 / 60;
      q.release(t, 0.1, lis, due);
    }
    expect(got[0][0]).toBe('boom');
    expect(got[0][1]).toBeCloseTo(680 / c, 9);
    expect(t).toBeGreaterThanOrEqual(got[0][1] - 0.1);
    expect(t).toBeLessThan(got[0][1]);
    expect(q.length).toBe(0);
  });

  it('drops sounds a camera cut left far behind, and refuses new ones when full', () => {
    const q = new DelayQueue<number>(3, 0.5);
    q.push(0, 0, 0, -10, 1);
    const got: number[] = [];
    // the listener jumped far past the wavefront long ago: dropped, not played late
    q.release(10, 0.1, still(0, 0, 0), (i) => got.push(i.payload));
    expect(got).toEqual([]);
    expect(q.length).toBe(0);
    for (let i = 0; i < 5; i++) q.push(0, 0, 0, -1000, i);
    expect(q.length).toBe(3);
    expect(q.refused).toBe(2);
    // they arrive at 2.94 s: released together just before; the first queued are kept
    q.release(2.9, 0.1, still(0, 0, 0), (i) => got.push(i.payload));
    expect(got).toEqual([0, 1, 2]);
  });
});

describe('impact aggregation', () => {
  it('65 rounds in one frame on one target are one sound', () => {
    const agg = new ImpactAggregator(30, 8);
    for (let i = 0; i < 65; i++) agg.add('armour', 1 + i * 0.001, (i % 7) - 3, 0, (i % 5) - 2);
    const out: { count: number; t: number; strength: number }[] = [];
    agg.flush((g) => out.push({ count: g.count, t: g.t, strength: g.strength }));
    expect(out).toEqual([{ count: 65, t: 1, strength: 65 }]);
    expect(agg.size).toBe(0);
  });

  it('a burst at 65 rounds/s over 60 frames makes at most a couple of sounds per frame', () => {
    const agg = new ImpactAggregator();
    let total = 0;
    let groups = 0;
    let maxPerFrame = 0;
    let n = 0;
    for (let f = 0; f < 60; f++) {
      while (n < ((f + 1) * 65) / 60) {
        const kind = n % 6 === 5 ? 'hei' : 'armour';
        agg.add(kind, n / 65, n * 0.5, 0, 0);
        n++;
      }
      let frame = 0;
      agg.flush((g) => {
        total += g.count;
        frame++;
      });
      groups += frame;
      maxPerFrame = Math.max(maxPerFrame, frame);
    }
    expect(total).toBe(65);
    expect(maxPerFrame).toBeLessThanOrEqual(2);
    expect(groups).toBeLessThan(65);
  });

  it('separate areas and kinds stay separate, never more than the group limit', () => {
    const agg = new ImpactAggregator(30, 4);
    for (let i = 0; i < 40; i++) agg.add(i % 2 ? 'ground' : 'hei', 0, i * 100, 0, 0);
    let groups = 0;
    let total = 0;
    agg.flush((g) => {
      groups++;
      total += g.count;
    });
    expect(groups).toBe(4);
    expect(total).toBe(40);
  });
});

describe('the aircraft history and the retarded time', () => {
  function history(): SourceHistory {
    const h = new SourceHistory(600);
    const s = createSourceSample();
    for (let f = 0; f <= 600; f++) {
      s.t = f / 60;
      // flying north at 150 m/s; the gun fires from 2 s on
      s.z = -150 * s.t;
      s.vz = -150;
      s.gunRate = s.t >= 2 ? 65 : 0;
      s.n1a = 0.5 + s.t / 20;
      h.push(s);
    }
    return h;
  }

  it('interpolates between frames and clamps to what it holds', () => {
    const h = history();
    expect(h.length).toBe(600); // capacity: the oldest dropped
    const out = createSourceSample();
    h.sample(5.0 + 1 / 120, out);
    expect(out.z).toBeCloseTo(-150 * (5 + 1 / 120), 6);
    h.sample(-50, out);
    expect(out.t).toBeCloseTo(h.oldest, 9);
    h.sample(1e6, out);
    expect(out.t).toBeCloseTo(10, 9);
  });

  it('the listener hears the source as it was when the sound left it', () => {
    const h = history();
    const out = createSourceSample();
    // a listener ahead of the aircraft, which approaches it
    const L = { x: 0, y: 0, z: -1500 - 340 };
    const tau = h.retarded(9, L, 340, out);
    // consistent: the sound left the source tau ago, from where the source was then
    expect(Math.hypot(out.x - L.x, out.y - L.y, out.z - L.z) / 340).toBeCloseTo(tau, 5);
    expect(out.t).toBeCloseTo(9 - tau, 5);
    // a burst that began at 2 s reaches a listener 1 km away 1 km / c later
    const far = { x: 1000, y: 0, z: -300 };
    const hearAt = (t: number) => (h.retarded(t, far, 340, out), out.gunRate);
    expect(hearAt(2 + 1000 / 340 - 0.05)).toBe(0);
    expect(hearAt(2 + 1010 / 340 + 0.05)).toBe(65);
  });
});
