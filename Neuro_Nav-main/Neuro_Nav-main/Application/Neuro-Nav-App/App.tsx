import { Picker } from '@react-native-picker/picker';
import * as Clipboard from 'expo-clipboard';
import { LinearGradient } from 'expo-linear-gradient';
import { StatusBar } from 'expo-status-bar';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Slider from '@react-native-community/slider';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { NovaPanel } from './components/NovaPanel';
import { SosModal } from './components/SosModal';
import { WaveformChart } from './components/WaveformChart';
import {
  N,
  RingBuffer,
  SR,
  buildPayload,
  computeMetrics,
  ControlMode,
  ControlState,
  fmt,
  generateDemoSamples,
  ingestFrame,
  resetSignalState,
} from './src/biosignal';
import { colors } from './src/theme';

function ts() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

export default function App() {
  const eegBuf = useRef(new RingBuffer(N));
  const emgBuf = useRef(new RingBuffer(N));
  const ecgBuf = useRef(new RingBuffer(N));
  const t0Ref = useRef(Date.now());
  const lastFrameRef = useRef(Date.now());
  const fpsAvg = useRef(60);
  const wsRef = useRef<WebSocket | null>(null);
  const lastAutoSentAt = useRef(0);
  const lastAutoCmd = useRef('—');
  const sendCmdRef = useRef<(cmd: string, origin: string) => void>(() => {});

  const [control, setControl] = useState<ControlState>({
    running: true,
    demo: true,
    armed: false,
    mode: 'manual',
    speed: 14,
    thr: 0.55,
    sens: 0.65,
  });
  const [rx, setRx] = useState(0);
  const [tx, setTx] = useState(0);
  const [lastCmd, setLastCmd] = useState('—');
  const [lastCmdAt, setLastCmdAt] = useState(0);
  const lastCmdAtRef = useRef(0);
  const controlRef = useRef(control);
  controlRef.current = control;
  lastCmdAtRef.current = lastCmdAt;
  const [fps, setFps] = useState('—');
  const [connKind, setConnKind] = useState<'IDLE' | 'OK' | 'WARN' | 'BAD'>('IDLE');
  const [connText, setConnText] = useState('No link');
  const [wsUrl, setWsUrl] = useState('ws://localhost:8765');
  const [logLines, setLogLines] = useState<{ t: string; msg: string }[]>([]);
  const [metrics, setMetrics] = useState(() =>
    computeMetrics(eegBuf.current, emgBuf.current, ecgBuf.current, controlRef.current, lastCmdAtRef.current),
  );
  const [frame, setFrame] = useState(0);

  const [sosOpen, setSosOpen] = useState(false);
  const [novaOpen, setNovaOpen] = useState(false);
  const [userLat, setUserLat] = useState<number | null>(null);
  const [userLon, setUserLon] = useState<number | null>(null);

  const log = useCallback((msg: string) => {
    setLogLines((prev) => [{ t: ts(), msg }, ...prev].slice(0, 80));
  }, []);

  const updatePayloadPreview = useCallback((cmd: string) => {
    return JSON.stringify(buildPayload(cmd, control), null, 2);
  }, [control]);

  const sendCmd = useCallback(
    (cmd: string, origin: string) => {
      if (!control.armed && cmd !== 'STOP') {
        log(`Blocked command "${cmd}" (SAFE).`);
        return;
      }
      const payload = buildPayload(cmd, control);
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify(payload));
          setTx((n) => n + 1);
          log(`Tx(${origin}): ${cmd} @${control.speed}`);
        } catch {
          log('WebSocket send failed.');
        }
      } else {
        log(`Cmd(${origin}): ${cmd} @${control.speed} (no link)`);
      }
      setLastCmd(cmd);
      const now = Date.now();
      setLastCmdAt(now);
      lastCmdAtRef.current = now;
    },
    [control, log],
  );

  sendCmdRef.current = sendCmd;

  const handleIncoming = useCallback(
    (data: string) => {
      try {
        const msg = JSON.parse(data) as {
          eeg?: number | number[];
          emg?: number | number[];
          ecg?: number | number[];
        };
        ingestFrame(msg, eegBuf.current, emgBuf.current, ecgBuf.current);
      } catch {
        /* ignore */
      }
    },
    [],
  );

  const connectWS = useCallback(() => {
    const url = wsUrl.trim();
    if (!url) return;
    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;
      setConnKind('WARN');
      setConnText('Connecting…');
      log(`WebSocket connecting: ${url}`);
      ws.onopen = () => {
        setConnKind('OK');
        setConnText('WebSocket connected');
        log('WebSocket connected.');
      };
      ws.onclose = () => {
        setConnKind('IDLE');
        setConnText('WebSocket closed');
        log('WebSocket closed.');
      };
      ws.onerror = () => {
        setConnKind('BAD');
        setConnText('WebSocket error');
        log('WebSocket error.');
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          setRx((n) => n + 1);
          handleIncoming(ev.data);
        }
      };
    } catch {
      setConnKind('BAD');
      setConnText('WebSocket failed');
      log('WebSocket failed to initialize.');
    }
  }, [handleIncoming, log, wsUrl]);

  const disconnectWS = useCallback(() => {
    const ws = wsRef.current;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    wsRef.current = null;
    setConnKind('IDLE');
    setConnText('No link');
  }, []);

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const t = Date.now();
      const dt = Math.max(1e-3, (t - lastFrameRef.current) / 1000);
      lastFrameRef.current = t;
      fpsAvg.current = fpsAvg.current * 0.92 + (1 / dt) * 0.08;
      setFps(fmt(fpsAvg.current, 0));

      const c = controlRef.current;
      if (c.running && c.demo) {
        const elapsed = (t - t0Ref.current) / 1000;
        const targetSamples = Math.floor(elapsed * SR);
        const have = eegBuf.current.length();
        const need = Math.max(0, targetSamples - have);
        if (need > 0) {
          const samples = generateDemoSamples(need, have);
          for (const s of samples) {
            ingestFrame(s, eegBuf.current, emgBuf.current, ecgBuf.current);
          }
        }
      }

      const m = computeMetrics(
        eegBuf.current,
        emgBuf.current,
        ecgBuf.current,
        c,
        lastCmdAtRef.current,
      );
      setMetrics(m);

      if (c.running && c.armed) {
        const now = Date.now();
        const gate = m.nova.emgGate;
        const eegCmd = m.nova.eegCmd;
        const emgEnv = m.nova.emgEnv;
        const fire = (cmd: string, minMs: number) => {
          if (now - lastAutoSentAt.current < minMs && cmd === lastAutoCmd.current) return;
          lastAutoSentAt.current = now;
          lastAutoCmd.current = cmd;
          if (cmd === 'NEUTRAL') return;
          sendCmdRef.current(cmd, 'auto');
        };
        if (c.mode === 'assist') {
          if (gate) fire('F', 260);
          else fire('STOP', 260);
        } else if (c.mode === 'neuro') {
          const calm = emgEnv < c.thr * 0.6;
          if (calm) fire(eegCmd, 300);
          else fire('STOP', 250);
        }
      }

      setFrame((f) => (f + 1) % 1000000);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const eegArr = useMemo(() => eegBuf.current.toArray(), [frame]);
  const emgArr = useMemo(() => emgBuf.current.toArray(), [frame]);
  const ecgArr = useMemo(() => ecgBuf.current.toArray(), [frame]);

  const payloadText = useMemo(
    () => updatePayloadPreview(lastCmd === '—' ? 'STOP' : lastCmd),
    [lastCmd, updatePayloadPreview],
  );

  const connBadgeStyle =
    connKind === 'OK'
      ? styles.badgeOk
      : connKind === 'WARN'
        ? styles.badgeWarn
        : connKind === 'BAD'
          ? styles.badgeBad
          : styles.badgeIdle;

  return (
    <SafeAreaProvider>
    <LinearGradient colors={[colors.ink950, colors.ink900]} style={styles.root}>
      <StatusBar style="light" />
      <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.headerRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.h1}>Neuro Nav</Text>
              <View style={styles.badgeInline}>
                <Text style={styles.badgeInlineText}>NPG Lite • ESP32 • L298N</Text>
              </View>
              <Text style={styles.sub}>
                Real-time EEG / EMG / ECG visualization + wheelchair command console.
              </Text>
            </View>
            <View style={styles.headerBtns}>
              <BtnSos onPress={() => setSosOpen(true)} />
              <Btn
                label="Demo stream"
                onPress={() => {
                  t0Ref.current = Date.now();
                  eegBuf.current.reset();
                  emgBuf.current.reset();
                  ecgBuf.current.reset();
                  resetSignalState();
                  setControl((c) => ({ ...c, demo: true, running: true }));
                  log('Demo stream started.');
                }}
                primary
              />
              <Btn
                label={control.running ? 'Pause' : 'Resume'}
                onPress={() => {
                  setControl((c) => {
                    const running = !c.running;
                    log(running ? 'Resumed.' : 'Paused.');
                    return { ...c, running };
                  });
                }}
              />
              <Btn
                label="Snapshot"
                onPress={async () => {
                  const snap = {
                    t: Date.now(),
                    eegRms: eegBuf.current.rms(),
                    emgEnv: metrics.nova.emgEnv,
                    bpm: metrics.nova.bpm,
                    mode: control.mode,
                    armed: control.armed,
                    lastCmd,
                  };
                  await Clipboard.setStringAsync(JSON.stringify(snap, null, 2));
                  log('Snapshot copied to clipboard.');
                }}
              />
              <View style={styles.fpsBox}>
                <Text style={styles.fpsMuted}>FPS</Text>
                <Text style={styles.fpsVal}>{fps}</Text>
                <Text style={styles.fpsMuted}>Buf</Text>
                <Text style={styles.fpsVal}>{metrics.buf}</Text>
              </View>
            </View>
          </View>

          <View style={styles.grid3}>
            <Card title="EEG" subtitle="Neural band" pill="cyan" rightLabel="Quality" rightValue={metrics.qEEG}>
              <WaveformChart data={eegArr} stroke="rgba(34,211,238,0.95)" glow="rgba(34,211,238,0.55)" scale={0.85} />
              <MetricRow
                a={['µV RMS', metrics.mEEGRms]}
                b={['Dominant', metrics.mEEGBand]}
                c={['Command', metrics.mEEGCmd, true]}
              />
            </Card>
            <Card title="EMG" subtitle="Muscle activity" pill="emerald" rightLabel="Effort" rightValue={metrics.qEMG}>
              <WaveformChart data={emgArr} stroke="rgba(52,211,153,0.92)" glow="rgba(52,211,153,0.50)" scale={1.1} />
              <MetricRow
                a={['Envelope', metrics.mEMGEnv]}
                b={['Threshold', metrics.mEMGThr]}
                c={['Gate', metrics.mEMGGate, true]}
              />
            </Card>
            <Card title="ECG" subtitle="Cardiac rhythm" pill="rose" rightLabel="HR" rightValue={metrics.qECG}>
              <WaveformChart data={ecgArr} stroke="rgba(251,113,133,0.92)" glow="rgba(251,113,133,0.48)" scale={1} />
              <MetricRow
                a={['BPM', metrics.mECGBpm]}
                b={['R-peaks', metrics.mECGPeaks]}
                c={['Status', metrics.mECGOk, true]}
              />
            </Card>
          </View>

          <View style={styles.grid2}>
            <View style={styles.card}>
              <View style={styles.cardH}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>Connection</Text>
                  <Text style={styles.cardSub}>WebSocket to ESP32 bridge (Serial N/A in Expo Go)</Text>
                </View>
                <View style={styles.connRow}>
                  <Text style={[styles.badge, connBadgeStyle]}>{connKind}</Text>
                  <Text style={styles.connTxt}>{connText}</Text>
                </View>
              </View>
              <View style={styles.cardB}>
                <View style={styles.row2}>
                  <Btn
                    label="Serial (N/A)"
                    onPress={() => {
                      setConnKind('WARN');
                      setConnText('Serial not in Expo Go');
                      log('Serial: use a dev build with native modules.');
                    }}
                  />
                  <Btn label="Connect WS" onPress={connectWS} primary />
                </View>
                <View style={styles.wsBox}>
                  <Text style={styles.hint}>WebSocket URL</Text>
                  <View style={styles.wsRow}>
                    <TextInput
                      value={wsUrl}
                      onChangeText={setWsUrl}
                      style={styles.input}
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                    <Btn label="Disconnect" onPress={disconnectWS} danger small />
                  </View>
                  <Text style={styles.hintSmall}>
                    JSON: {'{'} "t":123,"eeg":0.12,"emg":0.34,"ecg":0.08 {'}'}
                  </Text>
                </View>
                <View style={styles.rxtx}>
                  <MiniMetric k="Rx" v={String(rx)} />
                  <MiniMetric k="Tx" v={String(tx)} />
                </View>
              </View>
            </View>

            <View style={[styles.card, { flex: 1.4 }]}>
              <View style={styles.cardH}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>Wheelchair control</Text>
                  <Text style={styles.cardSub}>Manual + bio-signal intent (demo)</Text>
                </View>
                <View style={styles.modeRow}>
                  <Text style={styles.modeLbl}>Mode</Text>
                  <View style={styles.pickerWrap}>
                    <Picker
                      selectedValue={control.mode}
                      onValueChange={(v: ControlMode) => {
                        setControl((c) => ({ ...c, mode: v }));
                        log(`Mode set: ${v}`);
                      }}
                      style={styles.picker}
                      dropdownIconColor={colors.slate300}
                    >
                      <Picker.Item label="Manual" value="manual" />
                      <Picker.Item label="Assist (EMG gate)" value="assist" />
                      <Picker.Item label="Neuro (EEG intent)" value="neuro" />
                    </Picker>
                  </View>
                  <Text style={[styles.badge, control.armed ? styles.badgeOk : styles.badgeWarn]}>
                    {control.armed ? 'ARMED' : 'SAFE'}
                  </Text>
                </View>
              </View>
              <View style={styles.cardB}>
                <View style={styles.padRow}>
                  <View style={styles.padBox}>
                    <View style={styles.padHead}>
                      <Text style={styles.cardTitle}>Command pad</Text>
                      <Btn
                        small
                        primary
                        label={control.armed ? 'Disarm' : 'Arm'}
                        onPress={() => {
                          setControl((c) => {
                            const armed = !c.armed;
                            log(armed ? 'System ARMED.' : 'System SAFE.');
                            if (!armed) sendCmd('STOP', 'safety');
                            return { ...c, armed };
                          });
                        }}
                      />
                    </View>
                    <View style={styles.padGrid}>
                      <Pad label="▲" onPress={() => sendCmd('F', 'pad')} />
                      <Pad label="STOP" stop onPress={() => sendCmd('STOP', 'pad')} />
                      <Pad label="▼" onPress={() => sendCmd('B', 'pad')} />
                      <Pad label="◀" onPress={() => sendCmd('L', 'pad')} />
                      <Pad label="•" mid onPress={() => {}} />
                      <Pad label="▶" onPress={() => sendCmd('R', 'pad')} />
                    </View>
                    <View style={styles.rxtx}>
                      <MiniMetric k="Last cmd" v={lastCmd} accent />
                      <MiniMetric k="Latency" v={metrics.lat} />
                    </View>
                  </View>

                  <View style={styles.padBox}>
                    <Text style={styles.cardTitle}>Tuning</Text>
                    <TuningSlider
                      label="Speed (PWM)"
                      value={control.speed}
                      min={0}
                      max={255}
                      step={1}
                      display={String(control.speed)}
                      onChange={(speed) => setControl((c) => ({ ...c, speed }))}
                    />
                    <TuningSlider
                      label="EMG gate threshold"
                      value={control.thr}
                      min={0}
                      max={1}
                      step={0.01}
                      display={fmt(control.thr, 2)}
                      onChange={(thr) => setControl((c) => ({ ...c, thr }))}
                    />
                    <TuningSlider
                      label="EEG intent sensitivity"
                      value={control.sens}
                      min={0}
                      max={1}
                      step={0.01}
                      display={fmt(control.sens, 2)}
                      onChange={(sens) => setControl((c) => ({ ...c, sens }))}
                    />
                    <View style={styles.payloadBox}>
                      <View style={styles.padHead}>
                        <Text style={styles.hint}>Outgoing payload</Text>
                        <Btn
                          small
                          label="Copy"
                          onPress={async () => {
                            await Clipboard.setStringAsync(payloadText);
                            log('Payload copied.');
                          }}
                        />
                      </View>
                      <Text style={styles.payloadPre}>{payloadText}</Text>
                    </View>
                  </View>
                </View>

                <View style={styles.logBox}>
                  <View style={styles.padHead}>
                    <Text style={styles.cardTitle}>Event log</Text>
                    <Btn small label="Clear" onPress={() => setLogLines([])} />
                  </View>
                  <View style={styles.logList}>
                    {logLines.map((l, i) => (
                      <View key={i} style={styles.logRow}>
                        <Text style={styles.logTs}>{l.t}</Text>
                        <Text style={styles.logMsg}>{l.msg}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              </View>
            </View>
          </View>

          <Text style={styles.footer}>
            Tip: Swap the demo generator for real NPG Lite data via WebSocket from an ESP32 bridge.
          </Text>
        </ScrollView>

        <Pressable style={styles.fab} onPress={() => setNovaOpen(true)}>
          <Text style={styles.fabText}>NOVA</Text>
        </Pressable>

        <SosModal
          visible={sosOpen}
          onClose={() => setSosOpen(false)}
          onUserLocation={(la, lo) => {
            setUserLat(la);
            setUserLon(lo);
          }}
          onLog={log}
        />

        <NovaPanel
          visible={novaOpen}
          onClose={() => setNovaOpen(false)}
          snapshot={metrics.nova}
          userLat={userLat}
          userLon={userLon}
        />
      </SafeAreaView>
    </LinearGradient>
    </SafeAreaProvider>
  );
}

function Card({
  title,
  subtitle,
  pill,
  rightLabel,
  rightValue,
  children,
}: {
  title: string;
  subtitle: string;
  pill: 'cyan' | 'emerald' | 'rose';
  rightLabel: string;
  rightValue: string;
  children: ReactNode;
}) {
  const pillStyle =
    pill === 'cyan' ? styles.pillCyan : pill === 'emerald' ? styles.pillEmerald : styles.pillRose;
  return (
    <View style={styles.card}>
      <View style={styles.cardH}>
        <View style={styles.cardHeadLeft}>
          <Text style={[styles.pill, pillStyle]}>{title}</Text>
          <View>
            <Text style={styles.cardTitle}>{subtitle}</Text>
            <Text style={styles.cardSubSmall}>Live trace</Text>
          </View>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={styles.metricK}>{rightLabel}</Text>
          <Text style={styles.metricV}>{rightValue}</Text>
        </View>
      </View>
      <View style={styles.cardB}>{children}</View>
    </View>
  );
}

function MetricRow({
  a,
  b,
  c,
}: {
  a: [string, string];
  b: [string, string];
  c: [string, string, boolean?];
}) {
  return (
    <View style={styles.metricGrid}>
      <View style={styles.metric}>
        <Text style={styles.metricK}>{a[0]}</Text>
        <Text style={styles.metricV}>{a[1]}</Text>
      </View>
      <View style={styles.metric}>
        <Text style={styles.metricK}>{b[0]}</Text>
        <Text style={styles.metricV}>{b[1]}</Text>
      </View>
      <View style={styles.metric}>
        <Text style={styles.metricK}>{c[0]}</Text>
        <Text style={[styles.metricV, c[2] ? styles.metricAccent : null]}>{c[1]}</Text>
      </View>
    </View>
  );
}

function MiniMetric({ k, v, accent }: { k: string; v: string; accent?: boolean }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricK}>{k}</Text>
      <Text style={[styles.metricV, accent ? styles.metricAccent : null]}>{v}</Text>
    </View>
  );
}

function Btn({
  label,
  onPress,
  primary,
  danger,
  small,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  danger?: boolean;
  small?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.btn,
        small ? styles.btnSmall : null,
        primary ? styles.btnPrimary : null,
        danger ? styles.btnDanger : null,
      ]}
    >
      <Text style={styles.btnText}>{label}</Text>
    </Pressable>
  );
}

function BtnSos({ onPress }: { onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.btnSos}>
      <Text style={styles.btnSosText}>SOS</Text>
    </Pressable>
  );
}

function Pad({
  label,
  onPress,
  stop,
  mid,
}: {
  label: string;
  onPress: () => void;
  stop?: boolean;
  mid?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.pad, stop ? styles.padStop : null, mid ? styles.padMid : null]}
    >
      <Text style={styles.padTxt}>{label}</Text>
    </Pressable>
  );
}

function TuningSlider({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (n: number) => void;
}) {
  return (
    <View style={{ marginTop: 10 }}>
      <View style={styles.tuningHead}>
        <Text style={styles.hint}>{label}</Text>
        <Text style={styles.tuningVal}>{display}</Text>
      </View>
      <Slider
        minimumValue={min}
        maximumValue={max}
        step={step}
        value={value}
        onValueChange={onChange}
        minimumTrackTintColor={colors.cyan400}
        maximumTrackTintColor="rgba(255,255,255,0.15)"
        thumbTintColor={colors.slate100}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  safe: { flex: 1 },
  scroll: { paddingHorizontal: 16, paddingBottom: 100 },
  headerRow: { paddingTop: 12, gap: 12 },
  h1: { color: colors.slate100, fontSize: 22, fontWeight: '700' },
  sub: { color: colors.slate300, fontSize: 13, marginTop: 6 },
  badgeInline: {
    alignSelf: 'flex-start',
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(34,211,238,0.25)',
    backgroundColor: 'rgba(34,211,238,0.08)',
  },
  badgeInlineText: { color: colors.cyan200, fontSize: 11, fontWeight: '600' },
  headerBtns: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 8 },
  fpsBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  fpsMuted: { color: colors.slate300, fontSize: 11 },
  fpsVal: { color: colors.slate100, fontFamily: 'monospace', fontSize: 11 },
  grid3: { marginTop: 16, gap: 12 },
  grid2: { marginTop: 12, gap: 12 },
  card: {
    borderRadius: 22,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.glass,
    overflow: 'hidden',
  },
  cardH: {
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.08)',
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
  },
  cardB: { padding: 14, gap: 10 },
  cardTitle: { color: colors.slate100, fontSize: 14, fontWeight: '600' },
  cardSub: { color: colors.slate300, fontSize: 11, marginTop: 4 },
  cardSubSmall: { color: colors.slate400, fontSize: 10, marginTop: 2 },
  cardHeadLeft: { flexDirection: 'row', gap: 10, flex: 1, alignItems: 'center' },
  pill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    overflow: 'hidden',
    fontSize: 11,
    fontWeight: '800',
    color: colors.slate100,
  },
  pillCyan: { backgroundColor: 'rgba(34,211,238,0.12)', borderWidth: 1, borderColor: 'rgba(34,211,238,0.25)' },
  pillEmerald: { backgroundColor: 'rgba(52,211,153,0.12)', borderWidth: 1, borderColor: 'rgba(52,211,153,0.25)' },
  pillRose: { backgroundColor: 'rgba(251,113,133,0.12)', borderWidth: 1, borderColor: 'rgba(251,113,133,0.25)' },
  metricGrid: { flexDirection: 'row', gap: 8, marginTop: 10 },
  metric: { flex: 1, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', padding: 8 },
  metricK: { color: colors.slate400, fontSize: 10 },
  metricV: { color: colors.slate100, fontSize: 12, fontWeight: '600', marginTop: 4, fontFamily: 'monospace' },
  metricAccent: { color: colors.cyan200 },
  connRow: { alignItems: 'flex-end', gap: 4 },
  connTxt: { color: colors.slate300, fontSize: 11 },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    overflow: 'hidden',
    fontSize: 10,
    fontWeight: '800',
    color: colors.slate100,
  },
  badgeIdle: { backgroundColor: 'rgba(148,163,184,0.15)' },
  badgeOk: { backgroundColor: 'rgba(52,211,153,0.18)' },
  badgeWarn: { backgroundColor: 'rgba(251,191,36,0.18)' },
  badgeBad: { backgroundColor: 'rgba(244,63,94,0.18)' },
  row2: { flexDirection: 'row', gap: 8 },
  wsBox: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    backgroundColor: 'rgba(255,255,255,0.05)',
    padding: 10,
    gap: 8,
  },
  wsRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: {
    flex: 1,
    minHeight: 44,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    paddingHorizontal: 10,
    color: colors.slate100,
    backgroundColor: 'rgba(0,0,0,0.2)',
    fontFamily: 'monospace',
    fontSize: 12,
  },
  hint: { color: colors.slate300, fontSize: 11 },
  hintSmall: { color: colors.slate400, fontSize: 10, marginTop: 6 },
  rxtx: { flexDirection: 'row', gap: 8 },
  modeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  modeLbl: { color: colors.slate300, fontSize: 11 },
  pickerWrap: {
    width: 200,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.2)',
  },
  picker: { color: colors.slate100 },
  padRow: { gap: 12 },
  padBox: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    backgroundColor: 'rgba(255,255,255,0.05)',
    padding: 12,
  },
  padHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  padGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  pad: {
    width: '30%',
    minWidth: 90,
    flexGrow: 1,
    height: 48,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  padStop: { borderColor: 'rgba(244,63,94,0.35)', backgroundColor: 'rgba(244,63,94,0.10)' },
  padMid: { opacity: 0.5 },
  padTxt: { color: colors.slate100, fontSize: 16, fontWeight: '700' },
  payloadBox: {
    marginTop: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    backgroundColor: 'rgba(0,0,0,0.2)',
    padding: 10,
  },
  payloadPre: {
    marginTop: 8,
    color: colors.slate100,
    fontFamily: 'monospace',
    fontSize: 10,
    lineHeight: 14,
  },
  logBox: {
    marginTop: 8,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    backgroundColor: 'rgba(0,0,0,0.25)',
    padding: 10,
    maxHeight: 200,
  },
  logList: { marginTop: 8, gap: 6 },
  logRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  logTs: { color: colors.slate400, fontFamily: 'monospace', fontSize: 10, width: 110 },
  logMsg: { flex: 1, color: colors.slate100, fontSize: 11 },
  footer: { textAlign: 'center', color: colors.slate400, fontSize: 11, marginTop: 16, marginBottom: 8 },
  btn: {
    height: 42,
    paddingHorizontal: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: 'rgba(255,255,255,0.05)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnSmall: { height: 36, paddingHorizontal: 10 },
  btnPrimary: { borderColor: 'rgba(56,189,248,0.35)', backgroundColor: 'rgba(56,189,248,0.10)' },
  btnDanger: { borderColor: 'rgba(244,63,94,0.35)', backgroundColor: 'rgba(244,63,94,0.08)' },
  btnText: { color: colors.slate100, fontSize: 12, fontWeight: '700' },
  btnSos: {
    height: 42,
    paddingHorizontal: 14,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(244,63,94,0.45)',
    backgroundColor: 'rgba(244,63,94,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnSosText: { color: colors.rose200, fontSize: 13, fontWeight: '800' },
  fab: {
    position: 'absolute',
    right: 16,
    bottom: 20,
    height: 52,
    paddingHorizontal: 18,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(56,189,248,0.45)',
    backgroundColor: 'rgba(56,189,248,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  fabText: { color: colors.slate100, fontWeight: '900', letterSpacing: 3, fontSize: 13 },
  tuningHead: { flexDirection: 'row', justifyContent: 'space-between' },
  tuningVal: { color: colors.slate100, fontFamily: 'monospace', fontSize: 11 },
});
