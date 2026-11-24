#!/usr/bin/env bash
# Jet-radio treatment for a TTS line: bandpass, hard compression, soft clip,
# light crush, band-limited hiss under the call, squelch open/close from the
# game's own radio clicks. Pilot lines (mask=1) get a short boxy oxygen-mask echo.
# usage: radio.sh in.wav out.wav [mask 0|1] [variant 1|2]
in="$1"; out="$2"; mask="${3:-0}"; var="${4:-1}"
dir="$(dirname "$0")"
maskf=""; [ "$mask" = "1" ] && maskf=",aecho=0.8:0.5:7|13:0.35|0.2"
dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$in")
ffmpeg -y -v error \
  -i "$dir/radio_open_$var.m4a" -i "$in" -i "$dir/radio_close_$var.m4a" \
  -f lavfi -t "$(python -c "print($dur+0.5)")" -i "anoisesrc=color=pink:amplitude=0.05:sample_rate=48000" \
  -filter_complex "\
[1:a]aresample=48000,adelay=180|180,apad=pad_dur=0.12,highpass=f=380,highpass=f=380,lowpass=f=3100,lowpass=f=3100${maskf},acompressor=threshold=-26dB:ratio=8:attack=2:release=50:makeup=8,volume=4dB,asoftclip=type=tanh,acrusher=bits=11:mode=log:aa=1:mix=0.35,highpass=f=320,highpass=f=320,lowpass=f=3300,lowpass=f=3300,lowpass=f=3300,volume=-2dB[v];\
[3:a]highpass=f=500,lowpass=f=2800,volume=-30dB,afade=t=in:d=0.05,afade=t=out:st=$(python -c "print($dur+0.35)"):d=0.12[n];\
[v][n]amix=inputs=2:duration=first:normalize=0[vn];\
[0:a]aresample=48000,volume=-6dB[o];[2:a]aresample=48000,volume=-6dB[c];\
[o][vn][c]concat=n=3:v=0:a=1,loudnorm=I=-16:TP=-1.5:LRA=7[out]" \
  -map "[out]" -ac 2 -ar 48000 "$out"
