#!/usr/bin/env python3
"""
JARVIS Vision Analyzer — Windows version
Uses OpenCV + basic analysis since Apple Vision isn't available on Windows.
Falls back to a description based on what can be detected locally.
"""
import sys
import json
import io

_stderr = sys.stderr
sys.stderr = io.StringIO()

CV2_OK = False
PIL_OK = False

try:
    import cv2
    import numpy as np
    CV2_OK = True
except Exception:
    pass

try:
    from PIL import Image
    PIL_OK = True
except Exception:
    pass

sys.stderr = _stderr


def analyze(image_path):
    out = {"classifications": [], "faces": 0, "humans": 0, "text": [], "text_flipped": [], "error": None}

    if not CV2_OK:
        out["error"] = "opencv_missing"
        sys.stdout.write(json.dumps(out) + "\n")
        sys.stdout.flush()
        return

    try:
        img = cv2.imread(image_path)
        if img is None:
            out["error"] = "load_failed"
            sys.stdout.write(json.dumps(out) + "\n")
            sys.stdout.flush()
            return

        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

        # Face detection using Haar cascade (built into OpenCV)
        face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
        faces = face_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(30, 30))
        out["faces"] = len(faces)

        # Basic scene analysis from image properties
        height, width = img.shape[:2]
        avg_brightness = np.mean(gray)
        classifications = []

        if len(faces) > 0:
            classifications.append({"label": "person", "confidence": 0.95})
        if avg_brightness < 80:
            classifications.append({"label": "dark scene", "confidence": 0.8})
        elif avg_brightness > 180:
            classifications.append({"label": "bright scene", "confidence": 0.8})

        # Detect dominant colors
        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
        avg_saturation = np.mean(hsv[:,:,1])
        if avg_saturation < 30:
            classifications.append({"label": "low color", "confidence": 0.7})

        out["classifications"] = classifications

    except Exception as e:
        out["error"] = str(e)

    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.stdout.write(json.dumps({"error": "no_path"}) + "\n")
        sys.stdout.flush()
    else:
        analyze(sys.argv[1])
