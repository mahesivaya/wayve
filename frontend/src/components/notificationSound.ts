// Alert sounds, synthesized so there are no audio files to ship or license.
//
// A browser keeps audio suspended until the page has seen a user gesture, so a
// call arriving before the first click is silent; the notification still shows.
// `primeNotificationSound` resumes it on the first gesture.

const RING_PERIOD_S = 3;
// Scheduled up front rather than on a timer, which a hidden tab throttles. This
// outlasts the caller's 30s ring timeout, and stopRingtone ends it sooner.
const RING_CYCLES = 15;
const PEAK_GAIN = 0.15;

let context: AudioContext | null = null;
let ringtone: { nodes: OscillatorNode[]; output: GainNode } | null = null;

function audioContext(): AudioContext | null {
  if (typeof AudioContext === "undefined") return null;
  context ??= new AudioContext();
  if (context.state === "suspended") void context.resume();
  return context;
}

// A short note with a soft attack and release, so it doesn't click.
function scheduleNote(
  ctx: AudioContext,
  output: AudioNode,
  { frequency, at, length }: { frequency: number; at: number; length: number }
): OscillatorNode {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(PEAK_GAIN, at + 0.02);
  gain.gain.linearRampToValueAtTime(0, at + length);
  oscillator.connect(gain);
  gain.connect(output);
  oscillator.start(at);
  oscillator.stop(at + length);
  return oscillator;
}

// Two rising notes for a one-off alert.
export function playChime(): void {
  const ctx = audioContext();
  if (!ctx) return;
  const now = ctx.currentTime;
  scheduleNote(ctx, ctx.destination, {
    frequency: 660,
    at: now,
    length: 0.18,
  });
  scheduleNote(ctx, ctx.destination, {
    frequency: 880,
    at: now + 0.16,
    length: 0.28,
  });
}

export function startRingtone(): void {
  const ctx = audioContext();
  if (!ctx || ringtone) return;
  const output = ctx.createGain();
  output.connect(ctx.destination);
  const nodes: OscillatorNode[] = [];
  for (let cycle = 0; cycle < RING_CYCLES; cycle++) {
    const at = ctx.currentTime + cycle * RING_PERIOD_S;
    nodes.push(
      scheduleNote(ctx, output, { frequency: 880, at, length: 0.4 }),
      scheduleNote(ctx, output, { frequency: 740, at: at + 0.5, length: 0.4 })
    );
  }
  ringtone = { nodes, output };
}

export function stopRingtone(): void {
  if (!ringtone) return;
  for (const node of ringtone.nodes) {
    try {
      node.stop();
    } catch {
      // Already finished.
    }
  }
  ringtone.output.disconnect();
  ringtone = null;
}

export function primeNotificationSound(): () => void {
  const resume = () => {
    audioContext();
    document.removeEventListener("pointerdown", resume, true);
    document.removeEventListener("keydown", resume, true);
  };
  document.addEventListener("pointerdown", resume, true);
  document.addEventListener("keydown", resume, true);
  return () => {
    document.removeEventListener("pointerdown", resume, true);
    document.removeEventListener("keydown", resume, true);
  };
}
