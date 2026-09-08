"""Probe candidate real sources: render short dry side & classify stereo. Uses WET B file
(which is dry passed with DSP engaged) simply to get format; stereo measured from A(dry)."""
import os, subprocess, wave, struct, math
DEMO = r"C:\Program Files\Image-Line\FL Studio 2025\Data\Patches\Misc\Used by demo projects"
EXE  = r"C:\Users\khrit\Desktop\plugin\build\plugins\PresenceField\PresenceField_OfflineRender_artefacts\Release\PresenceField_OfflineRender.exe"
PROBE = r"C:\Users\khrit\Desktop\plugin\artifacts\_probe_pf"
os.makedirs(PROBE, exist_ok=True)

cands = {
  "attharch":       os.path.join(DEMO,"Atthar Feat Mehran Abbasi & Elise Chantelle - Right Night feeling","AttharCh.ogg"),
  "ast_verse6":     os.path.join(DEMO,"Astes - Bien Duro","1.3 Verse #6.ogg"),
  "ella_doubles":   os.path.join(DEMO,"Edlan & Ella No\u00ebl - Song For You","ella doubles.ogg"),
  "karra_harmony":  os.path.join(DEMO,"Bombs Away ft KARRA - Awake","Awake Vocal Harmony.ogg"),
  "dexperf_arp":    os.path.join(DEMO,"Charles Deluxe Performance Demo","Charles Deluxe Performance Demo Arp.wav"),
}
def probe(label, src):
    if not os.path.exists(src):
        print("%-16s MISSING %s" % (label, src)); return
    dry = os.path.join(PROBE, "p_%s_A.wav" % label)
    wet = os.path.join(PROBE, "p_%s_B.wav" % label)
    r = subprocess.run([EXE, src, dry, wet, "1.0", "3.0"], capture_output=True, text=True)
    if r.returncode != 0:
        print("%-16s FAIL %.60s" % (label, (r.stderr or r.stdout).strip())); return
    w = wave.open(dry); nf=w.getnframes(); sr=w.getframerate(); data=w.readframes(nf); w.close()
    L=[struct.unpack('<hh', data[i*4:i*4+4])[0] for i in range(nf)]
    R=[struct.unpack('<hh', data[i*4:i*4+4])[1] for i in range(nf)]
    def rms(v): return 20*math.log10(math.sqrt(sum(x*x for x in v)/len(v))/32768.0)
    def cov(x,y):
        mx=sum(x)/len(x); my=sum(y)/len(y)
        return sum((x[i]-mx)*(y[i]-my) for i in range(len(x)))/len(x)
    den=cov(L,L)*cov(R,R)
    c=cov(L,R)/math.sqrt(den) if den>0 else 0
    side=math.sqrt(sum(((L[i]-R[i])/2)**2 for i in range(len(L)))/len(L))
    kind = "STEREO" if c<0.97 else ("MONO" if c>0.9995 else "WEAK-STEREO")
    print("%-16s Lrms=%5.1fdB  Rrms=%5.1fdB  sideRms=%5.1fdB corr=%.4f dur=%.1fs -> %s" % (label, rms(L), rms(R), 20*math.log10(max(side/32768.0,1e-9)), c, nf/sr, kind))
    for f in (dry, wet):
        try: os.remove(f)
        except: pass
for L,s in cands.items(): probe(L,s)
