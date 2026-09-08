import wave, struct, os, sys

files = [
    'artifacts/ab-sources/ztame/ella_dry.wav',
    'artifacts/ab-sources/ztame/karra_dry.wav',
    'artifacts/ab-sources/ztame/madonna_dry.wav',
    'artifacts/ab-sources/ztame/mix_dry.wav',
    'artifacts/ab-sources/zscorch/strings_dry.wav',
    'artifacts/ab-sources/zscorch/chorus_dry.wav',
    'artifacts/ab-sources/zscorch/ab-review/SET2_render_before.wav',
    'artifacts/ab-sources/presencefield/PF_guitar_A_dry.wav',
]

def rms_pk(f):
    w = wave.open(f)
    n = w.getnframes(); ch = w.getnchannels(); sr = w.getframerate(); sw = w.getsampwidth()
    data = w.readframes(min(n, 48000*20))
    w.close()
    samples = struct.unpack('<%dh' % (len(data)//2), data) if sw==2 else None
    if samples is None: return None,None
    nch = ch
    # compute per-channel rms and peak using first 5s representative
    import math
    per = [[] for _ in range(nch)]
    for i in range(0, len(samples), nch):
        frame = samples[i:i+nch]
        for c in range(nch):
            per[c].append(frame[c]/32768.0)
    out=[]
    for c in range(nch):
        v=per[c]
        rms = math.sqrt(sum(x*x for x in v)/len(v))
        rmsdb = 20*math.log10(max(rms,1e-9))
        peak = max(max(v),-min(v))
        peakdb = 20*math.log10(max(peak,1e-9))
        out.append((rmsdb,peakdb))
    def interleRms():
        tot=0.0
        for c in range(nch):
            v=per[c]
            tot+=sum(x*x for x in v)
        return 20*math.log10(math.sqrt(tot/(nch*len(per[0])))+1e-9)
    return out, interleRms()

for f in files:
    if not os.path.exists(f):
        print(f,'MISSING'); continue
    w = wave.open(f)
    dur = w.getnframes()/w.getframerate()
    ch=w.getnchannels(); sr=w.getframerate()
    w.close()
    perch, inter = rms_pk(f)
    ps = ','.join('%.1fdB/%.1fdB'%(r,p) for r,p in perch) if perch else '?'
    print('%-60s ch=%d sr=%d dur=%.2fs  perch(RMS/Peak)%s interRMS=%.1f' % (f, ch, sr, dur, ps, inter))
