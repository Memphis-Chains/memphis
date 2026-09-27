import subprocess, os, shlex

FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'
W, H, FPS = 1920, 1080, 30
CREAM='0xf4f1ea'; INK='0x1a1d24'; DEEP='0xc44e1f'; BLUE='0x1a4d8f'; SOFT='0x4a4f5a'; PAPER='0xffffff'

def dt(text, x, y, size, color, **kw):
    t = text.replace('\\','\\\\').replace(':','\\:').replace("'","\\'").replace('%','\\%')
    return f"drawtext=fontfile={FONT}:text='{t}':x={x}:y={y}:fontsize={size}:fontcolor={color}" + ("" if not kw else ":" + kw)

def seg(name, dur, bg, accent, title, sub, lines, title_size=68):
    """bg/accent as 0xRRGGBB; lines = list of (text, size, color, y)"""
    vf = [f"drawbox=x=0:y=0:w=10:h={H}:color={accent}:t=fill",
          dt(title, 140, 170, title_size, accent),
          dt(sub, 142, 170+title_size+30, 34, SOFT),
          f"drawbox=x=142:y=380:w=120:h=7:color={accent}:t=fill"]
    y = 430
    for text, size, color in lines:
        vf.append(dt(text, 142, y, size, color))
        y += int(size * 1.55) + 14
    out = f"seg_{name}.mp4"
    vf_s = ','.join(vf)
    subprocess.run(['ffmpeg','-y','-loglevel','error',
        '-f','lavfi','-i',f'color=c={bg}:s={W}x{H}:r={FPS}:d={dur}',
        '-vf', vf_s, '-c:v','libx264','-pix_fmt','yuv420p','-crf','20','-preset','medium',
        '-r',str(FPS), out], check=True)
    print(f"  {out}  {dur}s")
    return out

# ── 6 segments, 30s total ──────────────────────────────────────
segs = []

segs.append(seg('a_hook', 4, CREAM, DEEP,
    'memphis-v5.pl',
    '30 sekund. Od zera do dzialajacego runtime.',
    [('curl -fsSL .../install.sh | bash', 40, BLUE),
     ('Jedna komenda. Node 22, Rust, 7 lancuchow.', 34, INK)]))

segs.append(seg('b_init', 5, CREAM, DEEP,
    'memphis init',
    'Passphrase, vault, tozsamosc. Pierwsze zapisy.',
    [('$ memphis init', 40, BLUE),
     ('Powiedz haslo operatora i haslo sejfu.', 34, INK),
     ('Vault szyfrowany AES-256 + Argon2id.', 34, INK)]))

segs.append(seg('c_provider', 6, CREAM, BLUE,
    'memphis provider add minimax',
    'Klucz leci do vault, nie do .env',
    [('$ memphis provider add minimax --api-key <KEY>', 36, BLUE),
     ('Klucz zapisany w zaszyfrowanym vault.', 34, INK),
     ('Nigdy nie trafia na dysk jako tekst.', 34, INK)]))

segs.append(seg('d_run', 6, CREAM, DEEP,
    'memphis service install && memphis tui',
    'Native Rust cockpit w terminalu',
    [('$ memphis service install', 38, BLUE),
     ('$ memphis service restart', 38, BLUE),
     ('$ memphis tui   <-- kokpit operatora', 38, DEEP)]))

segs.append(seg('e_proof', 5, PAPER, DEEP,
    'memphis health',
    'Chain-backed memory. Zero telemetrii.',
    [('$ memphis health', 40, BLUE),
     ('13 000+ blokow, 12 lancuchow, vault OK.', 34, INK),
     ('Ollama -> Anthropic -> MiniMax -> fallback', 30, SOFT)]))

segs.append(seg('f_end', 4, CREAM, DEEP,
    'Apache-2.0. Made in Zawaja.',
    'github.com/Memphis-Chains/memphis',
    [('curl -fsSL .../install.sh | bash', 38, BLUE),
     ('0 telemetry. Twoje klucze, Twoj runtime.', 32, INK)]))

# concat
lst = 'concat.txt'
with open(lst,'w') as f:
    for s in segs: f.write(f"file '{s}'\n")
subprocess.run(['ffmpeg','-y','-loglevel','error','-f','concat','-safe','0','-i',lst,
    '-c','copy','silent.mp4'], check=True)
print('  silent.mp4 built')

# add subtle progress-bar animation? keep simple: crossfade-free concat + fade in/out
subprocess.run(['ffmpeg','-y','-loglevel','error','-i','silent.mp4',
    '-vf','fade=t=in:st=0:d=0.4,fade=t=out:st=27.6:d=0.4',
    '-c:v','libx264','-pix_fmt','yuv420p','-crf','20','-preset','medium',
    '-movflags','+faststart','memphis-install-30s.mp4'], check=True)
print('DONE memphis-install-30s.mp4')
