"""Stage + render two REAL FL-demo recordings through the PresenceField DSP
into 16-bit stereo dry(A)/wet(B) WAV pairs using PresenceField_OfflineRender.
Only reads the FL demo audio; writes outputs under artifacts staging dir."""
import os, subprocess, shutil, wave, struct, math, sys

DEMO = r"C:\Program Files\Image-Line\FL Studio 2025\Data\Patches\Misc\Used by demo projects"
EXE  = r"C:\Users\khrit\Desktop\plugin\build\plugins\PresenceField\PresenceField_OfflineRender_artefacts\Release\PresenceField_OfflineRender.exe"
STAGE = r"C:\Users\khrit\Desktop\plugin\artifacts\ab-sources\presencefield\pairs-v2"
os.makedirs(STAGE, exist_ok=True)

# label -> (source absolute .ogg, startSec, durSec)
pairs = {
    # Pair 1: REAL modern dance/melodic chorus (dense stereo full mix) - Astes - Bien Duro
    "chorus": (os.path.join(DEMO, "Astes - Bien Duro", "1.1 Chorus #2.ogg"), 1.0, 10.0),
    # Pair 2: REAL orchestral strings passage (different instrument, wide texture) - Sid De La Cruz
    "strings": (os.path.join(DEMO, "Sid De La Cruz - Secret Agent Rendezvous", "Sid De La Cruz - Secret Agent Rendezvous Strings.ogg"), 1.0, 10.0),
}

def run_render(label, src, start, dur):
    dry = os.path.join(STAGE, "PF2_%s_A_dry.wav" % label)
    wet = os.path.join(STAGE, "PF2_%s_B_presence.wav" % label)
    args = [EXE, src, dry, wet, str(start), str(dur)]
    r = subprocess.run(args, capture_output=True, text=True)
    print("=== render %s rc=%d ===" % (label, r.returncode))
    print("STDOUT:", r.stdout.strip())
    if r.stderr.strip(): print("STDERR:", r.stderr.strip()[:800])
    return r.returncode, dry, wet

def inspect_wav(path):
    if not os.path.exists(path): return None
    w = wave.open(path)
    nch, sw, sr, nf = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
    data = w.readframes(nf)
    w.close()
    n = len(data)//(nch*sw)
    vals = struct.unpack('<%dh' % (len(data)//2), data)
    # DC offset per channel, peak, rms (over whole if <= ~50s)
    per = [[] for _ in range(nch)]
    for i in range(0, len(vals), nch):
        fr = vals[i:i+nch]
        for c in range(nch): per[c].append(fr[c])
    import math
    res = {}
    for c in range(nch):
        mean = sum(per[c])/len(per[c])
        pk = max(max(per[c]), -min(per[c]))
        rms = math.sqrt(sum(x*x for x in per[c])/len(per[c]))
        res['ch%d'%c] = (mean, pk/32768.0, 20*math.log10(max(rms/32768.0,1e-9)))
    # boundary-first/last sample value (DC continuity check)
    first = vals[:nch]; last = vals[-nch:]
    return {'sr':sr,'ch':nch,'bits':sw*8,'frames':nf,'dur':nf/sr,
            'first':first,'last':last,'stats':res}

for label,(src,start,dur) in pairs.items():
    if not os.path.exists(src):
        print("SOURCE MISSING:", src); continue
    rc, dry, wet = run_render(label, src, start, dur)
    if rc != 0:
        print("RENDER FAILED rc=%d label=%s" % (rc, label)); continue
    for p in (dry, wet):
        info = inspect_wav(p)
        if not info: print("  MISSING WAV", p); continue
        st = info['stats']
        fmt = "sr=%d ch=%d bits=%d dur=%.2fs" % (info['sr'],info['ch'],info['bits'],info['dur'])
        dc = ' '.join('L0/R0: %.1f' % st['ch0'][0] for _ in [0]) if info['ch']==0 else 'DC: ' + ' | '.join('%s=%.1fLSB p=%.1f%% rms=%s' % (k, v[0], 100*v[1], v[2]) for k,v in st.items())
        print("  %-34s %s  first=%s last=%s" % (os.path.basename(p), fmt, info['first'], info['last']))
        print("     %s" % dc)
print("DONE")
