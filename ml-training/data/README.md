# data/

Gitignored. Regenerate with `python scripts/prepare_dataset.py` from `ml-training/`.

Layout after prep:
```
data/
├── taco/                      # cached TACO download (annotations.json + raw images)
├── images/{train,val,test}/   # YOLO input images
└── labels/{train,val,test}/   # YOLO .txt labels, one per image
```

Class mapping (TACO supercategory → our class) lives in `scripts/prepare_dataset.py`.
See `classes.yaml` for the canonical class list.
