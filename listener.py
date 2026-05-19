#!/usr/bin/env python3
"""
JARVIS Listener
- Reads stdin for SLEEP/WAKE control signals from main process
- Sends: READY / WAKE / CMD:text / HEARD:text / ERR:text
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

# Shared state — controlled by stdin thread
awake = False
awake_lock = threading.Lock()

def stdin_reader():
    """Reads control signals from main process via stdin."""
    global awake
    for line in sys.stdin:
        line = line.strip()
        if line == 'SLEEP':
            with awake_lock:
                awake = False
            print("STATE:SLEEPING", flush=True)
        elif line == 'WAKE':
            with awake_lock:
                awake = True
            print("STATE:AWAKE", flush=True)

def main():
    global awake

    r = sr.Recognizer()
    r.energy_threshold = 350
    r.dynamic_energy_threshold = True
    r.dynamic_energy_adjustment_damping = 0.15
    r.dynamic_energy_ratio = 1.5
    r.pause_threshold = 0.9        # wait longer after silence before cutting
    r.phrase_threshold = 0.2
    r.non_speaking_duration = 0.6  # longer silence needed to end phrase

    try:
        mic = sr.Microphone()
    except Exception as e:
        print(f"ERR:No microphone: {e}", flush=True)
        sys.exit(1)

    with mic as source:
        r.adjust_for_ambient_noise(source, duration=0.8)

    print("READY", flush=True)

    # Start stdin reader thread so main process can control awake state
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
                # Always check for wake phrase regardless of state
                if is_wake(text_lower):
                    if now - last_wake_time > 3:
                        last_wake_time = now
                        with awake_lock:
                            awake = True
                        print("WAKE", flush=True)
            else:
                # Skip if it's just the wake phrase repeated
                if is_wake(text_lower):
                    continue
                # Debounce commands
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
