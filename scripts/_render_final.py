"""Render two REAL-source dry(A)/wet(B) pairs through PresenceField DSP to staging.
Only reads FL demo audio (real recordings); writes 16-bit stereo WAV pairs.
"""
import os, subprocess, wave, struct, math, shutil

DEMO = "C:/Program Files/Image-Line/FL Studio 2025/Data/Patches/Misc/Used by demo projects"
EXE  = r"C:\Users\khrit\Desktop\plugin\build\plugins\PresenceField\PresenceField_OfflineRender_artefacts\Release\PresenceField_OfflineRender.exe"
STAGE = r"C:\Users\khrit\Desktop\plugin\artifacts\ab-sources\presencefield\pairs-v2"
os.makedirs(STAGE, exist_ok=True)

pairs = {
  # (tag, src, startSec, durSec)
  "vocals_harmony": (os.path.join(DEMO, "Bombs Away ft KARRA - Awake", "Awake Vocal Harmony.ogg"), 1.0, 9.0),
  "strings":        (os.path.join(DEMO, "Sid De La Cruz - Secret Agent Rendezvous",
                       "Sid De La Cruz - Secret Agent Rendezvous Strings.ogg"), 1.0, 9.0),
}

def run(tag, src, start, dur, out_root):
    dry = os.path.join(out_root, "PF_%s_A_dry.wav" % tag)
    wet = os.path.join(out_root, "PF_%s_B_presence.wav" % tag)
    r = subprocess.run([EXE, src, dry, wet, str(start), str(dur)], capture_output=True, text=True)
    print("render %-16s rc=%d" % (tag, r.returncode))
    if r.stdout: print("   ", r.stdout.strip())
    if r.stderr: print("   ERR", r.stderr.strip()[:300])
    return r.returncode, dry, wet

for tag,(src,start,dur) in pairs.items():
    if not os.path.exists(src):
        print("MISSING source", src); continue
    rc, dry, wet = run(tag, src, start, dur, STAGE)
    if rc != 0: continue
    # quick equivalence + cleanliness
    def info(p):
        w=wave.open(p); nf=w.getnframes(); sr=w.getframerate(); data=w.readframes(nf); ch=w.getnchannels(); w.close()
        v=[struct.unpack('<hh', data[i*4:i*4+4]) for i in range(nf)]
        L=[x[0] for x in v]; R=[x[1] for x in v]
        dc=(sum(L)+sum(R))/(2*nf)
        rms=math.sqrt(sum(a*a+b*b for a,b in zip(L,R))/(2*nf))/32768.0
        return dict(nf=nf, sr=sr, dc=dc, rms=20*math.log10(max(rms,1e-9)))
    a=info(dry); b=info(wet)
    same_len = a['nf']==b['nf']
    differs  = open(dry,'rb').read()!=open(wet,'rb').read()
    print("   %-30s dur=%.2fs rms=%5.1fdB dc(LSB)=%.2f" % (os.path.basename(dry), a['nf']/a['sr'], a['rms'], a['dc']))
    print("   %-30s dur=%.2fs rms=%5.1fdB dc(LSB)=%.2f sameLen=%s differs=%s" % (os.path.basename(wet), b['nf']/b['sr'], b['rms'], b['dc'], same_len, differs))

# cleanup old non-final chorus probe output if present
print("stage dir now:")
for f in sorted(os.listdir(STAGE)):
    print("   ", f)
