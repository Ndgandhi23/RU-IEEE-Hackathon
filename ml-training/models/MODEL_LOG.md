# Model Log

Human-readable log of training runs. One entry per model shipped to `models/`.

Template:

```
## trash_vN — YYYY-MM-DD
- Base: yolov8n.pt (or prior trash_vN-1)
- Data: TACO (N images) [+ Rutgers (M images)]
- Epochs: X, imgsz: Y, batch: Z
- Result: mAP@0.5 = 0.XX, per-class recall = {...}
- Deployed: yes/no
- Notes:
```
