import os, re
root = r"C:\Program Files\Image-Line\FL Studio 2025\Data\Patches\Misc\Used by demo projects"
skip = {"Seamless - Menagerie"}  # solo-guitar project already auditioned for PF
for d in sorted(os.listdir(root)):
    full = os.path.join(root, d)
    if not os.path.isdir(full):
        continue
    try:
        files = [f for f in os.listdir(full) if f.lower().endswith('.ogg')]
    except Exception as e:
        files = []
    # only show folders that have files, exclude the guitar-solo one
    if not files or d in skip:
        continue
    # summarize by section type counts + a representative large file (likely dense/full)
    print("=== %s  (%d ogg files) ===" % (d, len(files)))
    for f in sorted(files, key=lambda x: os.path.getsize(os.path.join(full,x)), reverse=True)[:4]:
        p = os.path.join(full, f)
        print("    %-12s  %8.1f KB" % (f, os.path.getsize(p)/1024.0))
