"""Application-owned Blender batch entry. Jobs are isolated from desktop windows."""
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile

import bpy

job = json.loads(Path(__file__).with_name("job.json").read_text(encoding="utf-8"))
destination = Path(job["blendFile"])
if destination.exists():
    bpy.ops.wm.open_mainfile(filepath=str(destination), load_ui=False, use_scripts=False)
else:
    bpy.ops.wm.read_factory_settings(use_empty=True)

output = io.StringIO()
with contextlib.redirect_stdout(output):
    exec(compile(job["code"], "<pi-desktop-blender>", "exec"), {"bpy": bpy, "__name__": "__main__"})

# Write beside the target, then atomically replace it. Failed code/render/save
# must leave the user's previous project intact.
destination.parent.mkdir(parents=True, exist_ok=True)
handle, staged = tempfile.mkstemp(prefix=".pi-blender-", suffix=".blend", dir=destination.parent)
os.close(handle)
os.unlink(staged)
try:
    bpy.ops.wm.save_as_mainfile(filepath=staged, check_existing=False)
    os.replace(staged, destination)
finally:
    if os.path.exists(staged):
        os.unlink(staged)

result = {"blendFile": str(destination), "output": output.getvalue()[-24000:],
          "objects": [{"name": obj.name, "type": obj.type} for obj in bpy.context.scene.objects][:500]}
Path(job["resultPath"]).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
