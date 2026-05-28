#!/usr/bin/env python3
"""
JARVIS Vision Analyzer
Uses Apple Vision framework for classification, face/human detection,
and text recognition (including mirrored text from webcam).
Outputs single JSON line to stdout.
"""
import sys
import os
import json
import io

# Silence all stderr during imports
_stderr = sys.stderr
sys.stderr = io.StringIO()

VISION_OK = False
PIL_OK = False

try:
    import objc
    import Quartz
    from Foundation import NSURL, NSData
    import Vision
    VISION_OK = True
except Exception:
    pass

try:
    from PIL import Image
    import PIL.ImageOps
    PIL_OK = True
except Exception:
    pass

sys.stderr = _stderr


def load_cg_image(path):
    url = NSURL.fileURLWithPath_(path)
    src = Quartz.CGImageSourceCreateWithURL(url, None)
    if not src:
        return None
    return Quartz.CGImageSourceCreateImageAtIndex(src, 0, None)


def run_requests(handler, requests):
    ok, _ = handler.performRequests_error_(requests, None)
    return ok


def recognize_text_cg(cg_image, accurate=True):
    """Run Vision text recognition on a CGImage."""
    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cg_image, {})
    req = Vision.VNRecognizeTextRequest.alloc().init()
    level = Vision.VNRequestTextRecognitionLevelAccurate if accurate else Vision.VNRequestTextRecognitionLevelFast
    req.setRecognitionLevel_(level)
    req.setUsesLanguageCorrection_(True)
    ok, _ = handler.performRequests_error_([req], None)
    results = []
    if ok and req.results():
        for obs in req.results():
            cands = obs.topCandidates_(1)
            if cands and len(cands) > 0:
                t = str(cands[0].string()).strip()
                if t:
                    results.append(t)
    return results


def flip_image_horizontally(image_path):
    """Save a horizontally flipped version of the image, return new path."""
    if not PIL_OK:
        return None
    try:
        img = Image.open(image_path)
        flipped = PIL.ImageOps.mirror(img)
        flipped_path = image_path.replace('.jpg', '_flipped.jpg').replace('.jpeg', '_flipped.jpeg').replace('.png', '_flipped.png')
        if flipped_path == image_path:
            flipped_path = image_path + '_flipped.jpg'
        flipped.save(flipped_path, 'JPEG', quality=85)
        return flipped_path
    except Exception:
        return None


def analyze(image_path):
    out = {
        "classifications": [],
        "faces": 0,
        "humans": 0,
        "text": [],
        "text_flipped": [],
        "error": None
    }

    if not VISION_OK:
        out["error"] = "pyobjc_missing"
        sys.stdout.write(json.dumps(out) + "\n")
        sys.stdout.flush()
        return

    try:
        cg = load_cg_image(image_path)
        if not cg:
            out["error"] = "load_failed"
            sys.stdout.write(json.dumps(out) + "\n")
            sys.stdout.flush()
            return

        handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cg, {})

        # 1. Classify image
        req_cls = Vision.VNClassifyImageRequest.alloc().init()
        ok1, _ = handler.performRequests_error_([req_cls], None)
        if ok1 and req_cls.results():
            for obs in req_cls.results():
                c = float(obs.confidence())
                if c > 0.07:
                    label = str(obs.identifier()).replace('_', ' ')
                    out["classifications"].append({"label": label, "confidence": round(c, 3)})

        # 2. Face detection
        req_face = Vision.VNDetectFaceRectanglesRequest.alloc().init()
        ok2, _ = handler.performRequests_error_([req_face], None)
        if ok2 and req_face.results():
            out["faces"] = len(req_face.results())

        # 3. Human body detection
        try:
            req_body = Vision.VNDetectHumanRectanglesRequest.alloc().init()
            ok3, _ = handler.performRequests_error_([req_body], None)
            if ok3 and req_body.results():
                out["humans"] = len(req_body.results())
        except Exception:
            pass

        # 4. Text recognition on original image
        out["text"] = recognize_text_cg(cg, accurate=True)

        # 5. Text recognition on FLIPPED image (webcam mirrors text)
        # This catches text that appears backwards in the webcam feed
        flipped_path = flip_image_horizontally(image_path)
        if flipped_path:
            try:
                cg_flip = load_cg_image(flipped_path)
                if cg_flip:
                    flipped_text = recognize_text_cg(cg_flip, accurate=True)
                    # Only include text that wasn't already found in original
                    orig_set = set(out["text"])
                    out["text_flipped"] = [t for t in flipped_text if t not in orig_set]
            except Exception:
                pass
            # Clean up temp file
            try:
                os.remove(flipped_path)
            except Exception:
                pass

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
