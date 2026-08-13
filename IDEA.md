Build and ship a **high-quality browser-based MiG-21 reconnaissance flight experience** set in a vast, effectively infinite procedurally generated snowy Kargil/Ladakh-inspired Himalayan landscape.

Use the aircraft model in `models/`, visual references in `ref/`, and study https://docs.threejsskypro.com/ plus strong current Three.js/WebGPU flight, terrain, atmosphere and game-feel references where useful.

This experience is heavily inspired in **tone, atmosphere and emotional weight by Operation Safed Sagar and the 1999 Kargil War**, including the recent *Operation Safed Sagar* series, but **do not copy its dialogue, music, scenes, logos, title design or other protected creative material**.

### Core experience

The fantasy is:

**Fly a MiG-21 at high speed through dramatic snow-covered mountains, navigate valleys and ridgelines, locate fictional enemy observation posts, frame them through a reconnaissance camera, capture useful photographs, and complete the sortie.**

This is a **focused recon-flight experience**, not a combat simulator. Do not add weapons, dogfighting, multiplayer, complex avionics or unrelated scope.

Prioritize:

**flight feel → camera → sense of speed → mountainous scale → atmosphere → recon gameplay → game juice → UI**

Implement an authentic-feeling but accessible arcade flight model with inertia, banking, pitch/yaw/roll, throttle, drag, gravity, speed-dependent handling and light stall behaviour.

Build an excellent spring-based cinematic chase camera with look-ahead, damping, speed-dependent FOV/distance and restrained vibration.

### World

Create deterministic, effectively infinite Kargil-inspired terrain using appropriate modern techniques such as ridged multifractal noise, FBM, domain warping, erosion shaping and terrain LOD/clipmaps.

It should feature:

* massive snow-covered peaks
* deep valleys and passes
* exposed dark rock and cliffs
* altitude/slope-based snow
* atmospheric haze and huge view distances
* volumetric/cloud systems and cloud shadows
* dramatic high-altitude sunlight
* seamless streaming at jet speeds
* floating-origin support where necessary

It should look geological and cinematic, **not like generic Perlin-noise terrain**.

### Recon gameplay

Generate roughly **4–6 fictional enemy observation posts** at interesting ridgelines, passes and mountain shoulders.

The player must locate, approach and photograph them.

Evaluate photographs using simple factors such as:

* target visibility
* framing
* distance
* screen coverage
* viewing angle

Successful captures should provide satisfying shutter/audio feedback, a photo thumbnail, target completion state and subtle mission feedback.

Complete all required reconnaissance objectives to finish the sortie.

### Game juice

Add restrained, polished feedback:

* jet exhaust / afterburner
* throttle-reactive engine audio
* wind increasing with airspeed
* subtle speed/FOV kick
* contrails
* wing condensation during hard manoeuvres where appropriate
* high-speed particles
* ridge snow/spindrift
* aircraft vibration
* sun glints
* terrain-proximity sensation
* spatial/doppler audio
* satisfying recon-camera feedback
* polished crash/restart feedback

Avoid excessive bloom, shake or arcade clutter.

### Presentation & emotional framing

Create a polished cinematic **intro/title sequence** before gameplay.

Suggested structure:

**1999 • KARGIL**

*High above the Himalayas, courage took flight.*

**SAFED SAGAR**
*A Reconnaissance Flight Experience*

Then:

> Inspired by the courage and sacrifice of the Indian Armed Forces during the Kargil War.

> With special respect to the Indian Air Force personnel who flew Operation Safed Sagar in support of soldiers fighting on the ground.

> In remembrance of all those who made the supreme sacrifice in service of India.

**Jai Hind. 🇮🇳**

Then transition cinematically into the aircraft/world and mission briefing.

Keep this sincere, understated and respectful. **Do not present the project as officially endorsed by the Indian Air Force, Indian Army, Ministry of Defence, Netflix, or the creators of the series. Do not use official insignia/logos unless already licensed for use.**

Do not gamify real casualties, real personnel or their sacrifice. Keep historical remembrance separate from scores and fictional mission outcomes.

### Mission ending

On success, use a cinematic result such as:

**MISSION ACCOMPLISHED**

**Reconnaissance complete. Intelligence secured.**

*For those who flew into impossible skies, and those who held the mountains below.*

**Jai Hind. 🇮🇳**

Then show captured recon photographs and sortie statistics.

On failure/crash:

**SORTIE ENDED**

**Mission incomplete.**

*Regroup. Return to the skies.*

`RETRY SORTIE`

Keep failure respectful rather than using real-world sacrifice as punishment or motivation.

### UI

Use a restrained period-military/aviation-inspired visual language:

* altitude
* airspeed
* heading
* throttle
* target bearing/range
* recon-camera state
* objectives completed
* minimal reticle

Make the intro, briefing, HUD, photography UI, mission-complete and failure screens feel like **one intentionally art-directed experience**, not separate developer UI panels.

### Technical target

Target a smooth **60 FPS / 1080p desktop experience** with sensible quality tiers.

Use modern Three.js/WebGPU approaches where appropriate. Optimize terrain streaming, clouds, particles, draw calls, memory, asset loading and garbage generation without sacrificing flight responsiveness.

### Autonomous execution

Use our existing loop harness fully.

Inspect the repository and assets first. Research only where it improves decisions. Make reasonable decisions autonomously. Reuse proven libraries/techniques where superior to custom implementations.

**Do not stop at a plan. Build, run and repeatedly play-test the actual experience.**

Use browser/Playwright visual inspection to iterate on:

* flight feel
* camera feel
* aircraft orientation/scale
* terrain quality and repetition
* terrain seams/LOD popping
* atmosphere and mountain scale
* sense of speed
* recon readability
* intro/ending presentation
* runtime errors
* performance

Continue the harness loop until the experience is **cohesive, polished, performant and genuinely enjoyable from title screen → flight → reconnaissance → mission ending.**

Do not spend cycles producing unnecessary documentation or reports. Ship the experience.