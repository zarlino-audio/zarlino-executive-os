import os
root = r"C:\Program Files\Image-Line\FL Studio 2025\Data\Patches\Misc\Used by demo projects"
wanted = ["Charles Deluxe Performance Demo", "One Day (Funky Mix)", "Bombs Away ft KARRA - Awake",
          "Raubana - LIFE", "Ookay - Thief", "WiseLabs - Nahash", "Purps On The Beat Feat Luclover - Stroll Up"]
for d in wanted:
    full = os.path.join(root, d)
    if not os.path.isdir(full):
        print("=== %s : (missing) ===" % d); continue
    files = [f for f in os.listdir(full) if f.lower().endswith(('.ogg','.wav','.mp3','.flac'))]
    files.sort(key=lambda f: os.path.getsize(os.path.join(full,f)), reverse=True)
    print("=== %s  (%d files) ===" % (d, len(files)))
    for f in files[:6]:
        print("    %8.1f KB  %s" % (os.path.getsize(os.path.join(full,f))/1024.0, f))
