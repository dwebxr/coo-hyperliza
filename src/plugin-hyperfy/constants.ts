// Talking gesture shown while the agent speaks (the agent itself moves no mouth; a coo-world client
// with lip sync on does that from the agent's voice).
// Optional: put a clip at src/plugin-hyperfy/public/emotes/emote-talk.glb (and rebuild) to use it instead of the world's own.
export const TALK_EMOTE = {
  name: "TALK",
  path: "emotes/emote-talk.glb",
  duration: -1,
  description: "Talking gesture while speaking"
};

// Locomotion emotes - these are special and update the Emotes object
export const LOCOMOTION_EMOTES = [
    {
      name: "WALK",
      path: "emotes/emote-walk.glb",
      duration: -1,
      description: "Walking animation"
    },
    {
      name: "RUN",
      path: "emotes/emote-run.glb",
      duration: -1,
      description: "Running animation"
    },
    {
      name: "IDLE",
      path: "emotes/emote-idle.glb",
      duration: -1,
      description: "Idle animation"
    },
    {
      name: "FLOAT",
      path: "emotes/emote-float.glb",
      duration: -1,
      description: "Floating/jumping animation"
    },
    {
      name: "FALL",
      path: "emotes/emote-fall.glb",
      duration: -1,
      description: "Falling animation"
    },
    {
      name: "FLIP",
      path: "emotes/emote-flip.glb",
      duration: -1,
      description: "Flip animation"
    }
];

// `duration`: how long playEmote shows the emote before going back to idle (managers/emote-manager.ts).
// Other clients loop an emote until it is cleared, so this is the clip's own length, in seconds:
// one full play. systems/loader.test.ts checks it against every clip as the agent parses it.
export const EMOTES_LIST = [
    {
      name: "crawling",
      path: "emotes/emote-crawling.glb",
      duration: 5.167,
      description: "Crawls on the ground. Great for pretending to be exhausted, desperate, or dramatically begging for attention."
    },
    {
      name: "crying",
      path: "emotes/emote-crying.glb",
      duration: 6.3,
      description: "Covers face and sobs. Use in emotional moments, to mock sadness in a funny way, or when someone roasts you too hard."
    },
    {
      name: "happy dance",
      path: "emotes/emote-dance-happy.glb",
      duration: 15.7,
      description: "Light, joyful dance. Use when you're in a good mood, teasing someone, or celebrating small wins."
    },
    {
      name: "dance hiphop",
      path: "emotes/emote-dance-hiphop.glb",
      duration: 2.233,
      description: "Hiphop-style rhythm with attitude. Great for chill vibes, playful moods, or being cocky."
    },
    {
        name: "dance breaking",
        path: "emotes/emote-dance-breaking.glb",
        duration: 6.733,
        description: "Breakdance-style moves. Show off, dominate the floor, or ironically flex after something minor."
    },
    {
      name: "dance popping",
      path: "emotes/emote-dance-popping.glb",
      duration: 16.3,
      description: "Sharp popping dance moves. Use when the beat drops, or when you want to stylishly react to someone’s message."
    },
    {
      name: "death",
      path: "emotes/emote-death.glb",
      duration: 2.3,
      description: "Dramatically collapses. Use to fake death for comedic effect, react to cringe, or when the topic is 'so dead'."
    },
    {
      name: "firing gun",
      path: "emotes/emote-firing-gun.glb",
      duration: 1.2,
      description: "Mimics shooting with a gun. Playfully call someone out, respond to spicy takes, or pretend to ‘end’ a debate."
    },
    {
      name: "kiss",
      path: "emotes/emote-kiss.glb",
      duration: 4.6,
      description: "Blows a kiss. Use to flirt, thank someone, or jokingly send love after saying something chaotic."
    },
    {
      name: "looking around",
      path: "emotes/emote-looking-around.glb",
      duration: 6.367,
      description: "Scans the area, looking left and right. Great for ‘where is everyone?’, pretending not to notice something, or acting suspicious."
    },
    {
      name: "punch",
      path: "emotes/emote-punch.glb",
      duration: 3.267,
      description: "Throws a strong punch. Use when roasting, reacting to a betrayal, or play-fighting with friends."
    },
    {
      name: "rude gesture",
      path: "emotes/emote-rude-gesture.glb",
      duration: 2.7,
      description: "Makes an explicit hand gesture. Not safe for polite company — perfect for trolling or raw reactions."
    },
    {
      name: "sorrow",
      path: "emotes/emote-sorrow.glb",
      duration: 4.8,
      description: "Shows deep sadness, holding head down. Use when you're defeated, feeling dramatic, or being emo on purpose."
    },
    {
      name: "squat",
      path: "emotes/emote-squat.glb",
      duration: 1.9,
      description: "Goes into a deep squat. Good for idling, showing off posture, or pulling Eastern European gangster vibes."
    },
    {
      name: "waving both hands",
      path: "emotes/emote-waving-both-hands.glb",
      duration: 3.2,
      description: "Waves enthusiastically with both hands. Use to say hi, goodbye, or draw attention like 'I’m over here!'"
    }
];
