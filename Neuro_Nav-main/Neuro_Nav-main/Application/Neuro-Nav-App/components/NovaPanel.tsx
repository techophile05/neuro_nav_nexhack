import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { MetricsSnapshot } from '../src/biosignal';
import { novaBuildSignalAnalysis, novaHospitalsReply, novaMedicationReply, novaReply } from '../src/novaLogic';
import { colors } from '../src/theme';

type Msg = { role: 'user' | 'nova'; text: string };

type Props = {
  visible: boolean;
  onClose: () => void;
  snapshot: MetricsSnapshot;
  userLat: number | null;
  userLon: number | null;
};

export function NovaPanel({ visible, onClose, snapshot, userLat, userLon }: Props) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);

  const pushNova = (text: string) => setMessages((m) => [...m, { role: 'nova', text }]);
  const pushUser = (text: string) => setMessages((m) => [...m, { role: 'user', text }]);

  const onOpen = () => {
    if (messages.length === 0) {
      pushNova(
        "Hello — I'm NOVA. I use this dashboard's EEG / EMG / ECG context to explain trends. I do not diagnose, prescribe, or replace emergency services.\n\nTap a chip or ask a question.",
      );
    }
  };

  const runChip = async (k: 'signals' | 'hospitals' | 'meds') => {
    let q = '';
    if (k === 'signals') q = 'Analyze my EEG, EMG, and ECG.';
    if (k === 'hospitals') q = 'Nearby hospitals.';
    if (k === 'meds') q = 'Medication safety.';
    pushUser(q);
    setThinking(true);
    try {
      let ans: string;
      if (k === 'hospitals') ans = await novaHospitalsReply(userLat, userLon);
      else if (k === 'meds') ans = novaMedicationReply();
      else ans = novaBuildSignalAnalysis(snapshot);
      pushNova(ans);
    } finally {
      setThinking(false);
    }
  };

  const send = async () => {
    const t = input.trim();
    if (!t) return;
    setInput('');
    pushUser(t);
    setThinking(true);
    try {
      const ans = await novaReply(t, snapshot, userLat, userLon);
      pushNova(ans);
    } finally {
      setThinking(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onShow={onOpen}>
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable style={styles.scrim} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.sheetHead}>
            <View style={{ flex: 1 }}>
              <Text style={styles.sheetTitle}>NOVA</Text>
              <Text style={styles.sheetSub}>
                Interprets dashboard trends only — not a doctor. For emergencies use SOS.
              </Text>
            </View>
            <Pressable onPress={onClose} style={styles.closeBtn}>
              <Text style={styles.closeTxt}>×</Text>
            </Pressable>
          </View>

          <View style={styles.chips}>
            <Pressable onPress={() => void runChip('signals')} style={styles.chip}>
              <Text style={styles.chipText}>Analyze signals</Text>
            </Pressable>
            <Pressable onPress={() => void runChip('hospitals')} style={styles.chip}>
              <Text style={styles.chipText}>Nearby hospitals</Text>
            </Pressable>
            <Pressable onPress={() => void runChip('meds')} style={styles.chip}>
              <Text style={styles.chipText}>Medication safety</Text>
            </Pressable>
          </View>

          <ScrollView style={styles.msgBox} contentContainerStyle={{ paddingBottom: 12 }}>
            {messages.map((m, i) => (
              <View
                key={i}
                style={[
                  styles.bubble,
                  m.role === 'user' ? styles.bubbleUser : styles.bubbleNova,
                ]}
              >
                <Text style={styles.bubbleMeta}>{m.role === 'user' ? 'You' : 'NOVA'}</Text>
                <Text style={styles.bubbleBody}>{m.text}</Text>
              </View>
            ))}
            {thinking ? <Text style={styles.thinking}>…</Text> : null}
          </ScrollView>

          <View style={styles.compose}>
            <TextInput
              value={input}
              onChangeText={setInput}
              placeholder="Ask NOVA about EEG, EMG, ECG, routing…"
              placeholderTextColor={colors.slate400}
              style={styles.inp}
              editable={!thinking}
              onSubmitEditing={() => void send()}
            />
            <Pressable onPress={() => void send()} style={styles.send} disabled={thinking}>
              <Text style={styles.sendTxt}>Send</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(2,6,23,0.72)' },
  sheet: {
    maxHeight: '88%',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: 1,
    borderColor: 'rgba(148,163,184,0.22)',
    backgroundColor: 'rgba(12,18,34,0.98)',
    paddingBottom: 10,
  },
  sheetHead: { flexDirection: 'row', padding: 14, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.08)' },
  sheetTitle: { color: colors.slate100, fontSize: 16, fontWeight: '700', letterSpacing: 2 },
  sheetSub: { color: colors.slate400, fontSize: 11, marginTop: 6, lineHeight: 15 },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  closeTxt: { color: colors.slate100, fontSize: 22, lineHeight: 24 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
  chip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(56,189,248,0.28)',
    backgroundColor: 'rgba(56,189,248,0.08)',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chipText: { color: colors.cyan200, fontSize: 11, fontWeight: '600' },
  msgBox: { maxHeight: 360, paddingHorizontal: 12 },
  bubble: {
    maxWidth: '92%',
    padding: 12,
    borderRadius: 16,
    marginBottom: 10,
  },
  bubbleUser: { alignSelf: 'flex-end', backgroundColor: 'rgba(56,189,248,0.10)', borderWidth: 1, borderColor: 'rgba(56,189,248,0.22)' },
  bubbleNova: { alignSelf: 'flex-start', backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)' },
  bubbleMeta: { color: colors.slate400, fontSize: 10, marginBottom: 6, fontWeight: '600' },
  bubbleBody: { color: colors.slate100, fontSize: 12, lineHeight: 18 },
  thinking: { color: colors.slate400, paddingHorizontal: 12 },
  compose: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingTop: 8, alignItems: 'center' },
  inp: {
    flex: 1,
    minHeight: 44,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    paddingHorizontal: 12,
    color: colors.slate100,
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  send: {
    height: 44,
    paddingHorizontal: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(56,189,248,0.35)',
    backgroundColor: 'rgba(56,189,248,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendTxt: { color: colors.slate100, fontWeight: '700' },
});
