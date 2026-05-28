#!/usr/bin/env python3
"""
JARVIS Listener — Windows version
Uses SpeechRecognition + Google SR
"""
import sys
import time
import threading

try:
    import speech_recognition as sr
except ImportError:
    print("INSTALL_REQUIRED", flush=True)
    sys.exit(1)

WAKE_PHRASES = [
    "wake up jarvis",
    "daddy's home",
    "daddys home",
    "daddy home",
    "hey jarvis",
    "jarvis wake up",
    "jarvis",
]

def is_wake(text):
    t = text.lower().strip()
    return any(w in t for w in WAKE_PHRASES)

awake = False
awake_lock = threading.Lock()

def stdin_reader():
    global awake
    for line in sys.stdin:
        line = line.strip()
        if line == 'SLEEP':
            with awake_lock:
                awake = False
        elif line == 'AWAKE':
            with awake_lock:
                awake = True

def main():
    global awake

    r = sr.Recognizer()
    r.energy_threshold = 350
    r.dynamic_energy_threshold = True
    r.pause_threshold = 0.9
    r.phrase_threshold = 0.2
    r.non_speaking_duration = 0.6

    try:
        mic = sr.Microphone()
    except Exception as e:
        print(f"ERR:No microphone: {e}", flush=True)
        sys.exit(1)

    with mic as source:
        r.adjust_for_ambient_noise(source, duration=0.8)

    print("READY", flush=True)

    t = threading.Thread(target=stdin_reader, daemon=True)
    t.start()

    last_wake_time = 0
    last_cmd_time  = 0

    while True:
        try:
            with mic as source:
                audio = r.listen(source, timeout=5, phrase_time_limit=12)

            try:
                text = r.recognize_google(audio)
            except sr.UnknownValueError:
                continue
            except sr.RequestError as e:
                print(f"ERR:Network: {e}", flush=True)
                time.sleep(1)
                continue

            text = text.strip()
            if not text:
                continue

            text_lower = text.lower()
            print(f"HEARD:{text}", flush=True)

            now = time.time()

            with awake_lock:
                currently_awake = awake

            if not currently_awake:
                if is_wake(text_lower):
                    if now - last_wake_time > 3:
                        last_wake_time = now
                        with awake_lock:
                            awake = True
                        print("WAKE", flush=True)
            else:
                if is_wake(text_lower):
                    continue
                if now - last_cmd_time < 0.8:
                    continue
                last_cmd_time = now
                print(f"CMD:{text}", flush=True)

        except sr.WaitTimeoutError:
            continue
        except KeyboardInterrupt:
            break
        except Exception as e:
            print(f"ERR:{e}", flush=True)
            time.sleep(0.5)

if __name__ == "__main__":
    main()
