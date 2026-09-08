"""Normalize each real A/B pair so the DRY (A) side sits at a shared RMS target.
Equal fixed gain applies to A and B of a pair (ratio preserved), then re-quantize to 16-bit.
Clean: linear gain, no shaping -> no added DC/crackle.
"""
import os, wave, struct, math, shutil
STAGE = r"C:\Users\khrit\Desktop\plugin\artifacts\ab-sources\presencefield\pairs-v2"
TARGET_DRY_RMS = -16.0   # dBFS dry target

pairs = [
    ("PF_vocals_harmony",),
    ("PF_strings",),
]
def rms_db(path):
    w=wave.open(path); nf=w.getnframes(); data=w.readframes(nf); w.close()
    v=[struct.unpack('<hh', data[i*4:i*4+4]) for i in range(nf)]
    rms=math.sqrt(sum(a*a+b*b for a,b in v)/(2*nf))/32768.0
    return 20*math.log10(max(rms,1e-12)), nf
def normalize(path, gain):
    w=wave.open(path); ch=w.getnchannels(); sw=w.getsampwidth(); sr=w.getframerate()
    data=w.readframes(w.getnframes()); w.close()
    if sw!=2: raise ValueError('not 16-bit: '+path)
    vals=[struct.unpack('<hh', data[i*4:i*4+4]) for i in range(len(data)//4)]
    nv=[(int(max(-32767,min(32767, round(a*gain)))), int(max(-32767,min(32767, round(b*gain))))) for a,b in vals]
    out=b''
    for a,b in nv:
        out += struct.pack('<hh', a, b)
    # rewrite a temp with header preserved by copying header region
    rw=wave.open(path,'rb'); params=rw.getparams(); rw.close()
    tmp=path+'.tmp'
    ww=wave.open(tmp,'wb'); ww.setparams(params); ww.writeframes(out); ww.close()
    os.replace(tmp, path)
    peak=max(max(abs(a),abs(b)) for a,b in nv)
    return peak

for (tag,) in pairs:
    a=os.path.join(STAGE, tag+"_A_dry.wav")
    b=os.path.join(STAGE, tag+"_B_presence.wav")
    rmsA0,_=rms_db(a)
    gain=10**((TARGET_DRY_RMS - rmsA0)/20.0)
    peakA=normalize(a, gain); peakB=normalize(b, gain)
    rmsA1,_=rms_db(a); rmsB1,_=rms_db(b)
    print("%-18s gain=%.2fx (%.1fdB)  dry -%.1f->%.1f dB | wet %.1f dB | B/A peak %d/%d" %
          (tag, gain, 20*math.log10(gain), rmsA0 if False else -999, rmsA1, rmsB1, peakB, peakA))
