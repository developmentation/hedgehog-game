/**
 * Word bank for Spindash Speller.
 *
 * Design notes, because the constraints here are unusual:
 *
 * - AUDIO FIRST. The word is never rendered on screen; the player hears it via
 *   speech synthesis and reads a text clue. So every entry has to survive being
 *   spoken by a mediocre TTS voice and still be spellable.
 * - HOMOPHONE SAFETY. Words whose common homophone is equally spellable are
 *   either excluded (THEIR/THERE, TO/TOO/TWO, BEAR/BARE, WEAK/WEEK...) or kept
 *   only when the clue nails the sense beyond argument (WHALE, VEIN, WITCH).
 * - CLUE RULES. A clue must uniquely pin its word among common English words,
 *   must be concrete rather than dictionary-vague, and must never contain the
 *   word or a shared root. `validateWordBank()` enforces the mechanical half of
 *   that (substring, length, duplicates, tier/length fit); the interesting half
 *   is a human judgement call made once per entry.
 * - `say` is a plain phonetic respelling, added ONLY where browser voices
 *   reliably stumble (silent letters, loan words, odd stress). Omitting it means
 *   the default pronunciation was judged good enough.
 * - Spelling is British-English-neutral: variants that split across dialects
 *   (COLOUR/COLOR, OMELETTE/OMELET, MOLLUSC/MOLLUSK) are excluded entirely,
 *   since the player cannot see which one we meant.
 */

export interface WordEntry {
  /** The word to spell, uppercase A-Z only, no spaces/punctuation. */
  word: string;
  /** Short definition or riddle-style clue shown as text. Never contains the word itself or an obvious inflection of it. */
  clue: string;
  /** Optional example sentence with the word replaced by "____". Used as a second hint. */
  sentence?: string;
  /** Difficulty tier 1..5. Drives word length, letter-set size and scroll speed. */
  tier: 1 | 2 | 3 | 4 | 5;
  /** Loose topic tag, for themed runs later. */
  topic: string;
  /**
   * Optional respelling passed to speech synthesis when the default
   * pronunciation is wrong (e.g. "colonel" -> "kernel"). Omit when the
   * synthesiser gets it right.
   */
  say?: string;
}

export const WORDS: WordEntry[] = [
  // ---------------------------------------------------------------- tier 1 --
  { word: 'ANT', clue: 'Tiny six-legged worker marching in a line to the picnic', tier: 1, topic: 'animals' },
  { word: 'OWL', clue: 'Night bird that hoots and swivels its head right round', tier: 1, topic: 'animals' },
  { word: 'FOX', clue: 'Bushy-tailed red raider of the henhouse', tier: 1, topic: 'animals' },
  { word: 'PIG', clue: 'Curly-tailed farm animal that wallows in mud', tier: 1, topic: 'animals' },
  { word: 'CRAB', clue: 'Sideways scuttler with pincers and a hard shell', sentence: 'A ____ nipped my toe in the rock pool.', tier: 1, topic: 'ocean' },
  { word: 'FROG', clue: 'Green hopper that begins life as a tadpole', sentence: 'The ____ leapt off the lily pad.', tier: 1, topic: 'animals' },
  { word: 'WOLF', clue: 'Grey pack hunter that howls at the full moon', tier: 1, topic: 'animals' },
  { word: 'SWAN', clue: 'Long-necked white bird gliding on the lake', tier: 1, topic: 'animals' },
  { word: 'LEAF', clue: 'Flat green solar panel on the end of a twig', tier: 1, topic: 'plants' },
  { word: 'CAVE', clue: 'Dark hollow in a cliff where bats hang', tier: 1, topic: 'nature' },
  { word: 'MOSS', clue: 'Soft green carpet growing on damp stone', tier: 1, topic: 'nature' },
  { word: 'FERN', clue: 'Shady plant with feathery fronds and no flowers', tier: 1, topic: 'nature' },
  { word: 'EGG', clue: 'Oval breakfast item cracked into a hot pan', tier: 1, topic: 'food' },
  { word: 'SOUP', clue: 'Hot liquid meal eaten with a spoon', tier: 1, topic: 'food' },
  { word: 'RICE', clue: 'Small white grains boiled to go with a curry', tier: 1, topic: 'food' },
  { word: 'MILK', clue: 'White drink from a cow, poured on cereal', tier: 1, topic: 'food' },
  { word: 'CAKE', clue: 'Sweet baked treat with candles on top', sentence: 'We lit nine candles on the ____.', tier: 1, topic: 'food' },
  { word: 'GAS', clue: 'State of matter that spreads to fill any container', tier: 1, topic: 'science' },
  { word: 'ATOM', clue: 'Smallest piece of an element, with a tiny nucleus', tier: 1, topic: 'science' },
  { word: 'IRON', clue: 'Metal that rusts and sticks to a magnet', tier: 1, topic: 'science' },
  { word: 'SUN', clue: 'Our nearest star, powered by fusion in its core', tier: 1, topic: 'space' },
  { word: 'MOON', clue: 'Rocky companion that circles us and pulls the tides', tier: 1, topic: 'space' },
  { word: 'STAR', clue: 'Faraway ball of hot gas that twinkles at night', tier: 1, topic: 'space' },
  { word: 'MARS', clue: 'Red planet with the tallest volcano in the solar system', sentence: 'A rover has been rolling across ____ for years.', tier: 1, topic: 'space' },
  { word: 'DRUM', clue: 'Skin stretched over a barrel and hit with sticks', tier: 1, topic: 'music' },
  { word: 'HORN', clue: 'Brass tube you blow for a blaring note', tier: 1, topic: 'music' },
  { word: 'GOAL', clue: 'The net you shoot at, and the point you score', tier: 1, topic: 'sport' },
  { word: 'PUCK', clue: 'Black rubber disc slid across the ice', tier: 1, topic: 'sport' },
  { word: 'FOG', clue: 'Cloud sitting on the ground that hides the road', tier: 1, topic: 'weather' },
  { word: 'HAIL', clue: 'Ice pellets that clatter off a tin roof', tier: 1, topic: 'weather' },
  { word: 'SNOW', clue: 'White flakes that settle and get thrown in a fight', tier: 1, topic: 'weather' },
  { word: 'WIND', clue: 'Moving air that fills a sail and spins a turbine', tier: 1, topic: 'weather' },
  { word: 'EAR', clue: 'Body part that catches sound and keeps you balanced', tier: 1, topic: 'body' },
  { word: 'RIB', clue: 'Curved bone in the cage around your lungs', tier: 1, topic: 'body' },
  { word: 'JAW', clue: 'Hinged bone that opens and shuts for biting', tier: 1, topic: 'body' },
  { word: 'LUNG', clue: 'Spongy organ that fills with air when you breathe in', sentence: 'He filled one ____ with air and dived.', tier: 1, topic: 'body' },
  { word: 'BONE', clue: 'Hard white part of the skeleton a dog will bury', tier: 1, topic: 'body' },
  { word: 'SAW', clue: 'Toothed blade pushed to cut through wood', tier: 1, topic: 'tools' },
  { word: 'AXE', clue: 'Chopping tool with a wedge head and a long handle', tier: 1, topic: 'tools' },
  { word: 'PINK', clue: 'Pale red, the shade of a piglet', tier: 1, topic: 'colours' },
  { word: 'GOLD', clue: 'Yellow metal made into medals and rings', tier: 1, topic: 'colours' },
  { word: 'NAVY', clue: 'Very dark blue, or a fleet of warships', tier: 1, topic: 'colours' },
  { word: 'JOY', clue: 'Bubbling feeling that makes you leap about', tier: 1, topic: 'emotions' },
  { word: 'FEAR', clue: 'Cold clutch in the chest when danger is close', tier: 1, topic: 'emotions' },
  { word: 'MAP', clue: 'Folded sheet showing roads, rivers and towns', tier: 1, topic: 'travel' },
  { word: 'JET', clue: 'Fast plane with engines and no propellers', tier: 1, topic: 'travel' },
  { word: 'ELF', clue: 'Pointy-eared woodland helper of old tales', tier: 1, topic: 'myth' },
  { word: 'TIDE', clue: 'Twice-daily rise and fall of the sea', tier: 1, topic: 'ocean' },
  { word: 'REEF', clue: 'Ridge of coral where clownfish dart about', tier: 1, topic: 'ocean' },
  { word: 'SEED', clue: 'Tiny package that grows into a whole plant', tier: 1, topic: 'plants' },
  { word: 'ROOT', clue: 'Underground part that drinks for the plant', tier: 1, topic: 'plants' },
  { word: 'BARN', clue: 'Big farm building storing hay and tractors', tier: 1, topic: 'buildings' },
  { word: 'ROOF', clue: 'The lid on the top of a house', tier: 1, topic: 'buildings' },
  { word: 'DOME', clue: 'Rounded roof shaped like half a ball', tier: 1, topic: 'buildings' },
  { word: 'DAWN', clue: 'First light, when the birds start singing', tier: 1, topic: 'time' },
  { word: 'DUSK', clue: 'Fading glow after the sun goes down', sentence: 'Bats came out at ____.', tier: 1, topic: 'time' },
  { word: 'NOON', clue: 'Middle of the day, when the sun is highest', tier: 1, topic: 'time' },
  { word: 'YEAR', clue: 'One full trip of Earth around the sun', tier: 1, topic: 'time' },
  { word: 'HAT', clue: 'Thing you wear on your head', tier: 1, topic: 'clothing' },
  { word: 'SOCK', clue: 'Soft tube worn inside a shoe', tier: 1, topic: 'clothing' },
  { word: 'COG', clue: 'Toothed wheel in a clockwork train', tier: 1, topic: 'machines' },
  { word: 'FAN', clue: 'Spinning blades that push cool air at you', tier: 1, topic: 'machines' },

  // ---------------------------------------------------------------- tier 2 --
  { word: 'ZEBRA', clue: 'Striped horse of the African plains', tier: 2, topic: 'animals' },
  { word: 'CAMEL', clue: 'Desert walker with humps that store fat', tier: 2, topic: 'animals' },
  { word: 'OTTER', clue: 'Sleek river swimmer with webbed feet and a flat tail', tier: 2, topic: 'animals' },
  { word: 'SKUNK', clue: 'Black and white sprayer of a foul warning mist', tier: 2, topic: 'animals' },
  { word: 'SLOTH', clue: 'Slow tree hanger that moves at a crawl', tier: 2, topic: 'animals' },
  { word: 'RIVER', clue: 'Freshwater flow running from the hills to the sea', tier: 2, topic: 'nature' },
  { word: 'CLIFF', clue: 'Steep rock face at the edge of the land', tier: 2, topic: 'nature' },
  { word: 'FROST', clue: 'White crystal coating on a cold morning window', tier: 2, topic: 'weather' },
  { word: 'MARSH', clue: 'Soggy low ground thick with reeds', tier: 2, topic: 'nature' },
  { word: 'BREAD', clue: 'Baked loaf sliced for toast', tier: 2, topic: 'food' },
  { word: 'HONEY', clue: 'Golden syrup made by bees', tier: 2, topic: 'food' },
  { word: 'LEMON', clue: 'Yellow citrus that puckers your face', tier: 2, topic: 'food' },
  { word: 'ONION', clue: 'Layered bulb that makes cooks weep', tier: 2, topic: 'food' },
  { word: 'MANGO', clue: 'Sweet orange tropical fruit with a flat stone', tier: 2, topic: 'food' },
  { word: 'BACON', clue: 'Salty strips of pork fried for breakfast', tier: 2, topic: 'food' },
  { word: 'PASTA', clue: 'Italian dough shapes boiled in salted water', tier: 2, topic: 'food' },
  { word: 'LASER', clue: 'Narrow beam of one pure colour of light', tier: 2, topic: 'science' },
  { word: 'PRISM', clue: 'Glass wedge that splits white light into a rainbow', sentence: 'A ____ threw colours across the wall.', tier: 2, topic: 'science' },
  { word: 'MAGMA', clue: 'Molten rock while it is still underground', sentence: 'Deep below the crust, ____ pushed upward.', tier: 2, topic: 'science' },
  { word: 'COMET', clue: 'Icy wanderer that grows a tail near the sun', tier: 2, topic: 'space' },
  { word: 'ORBIT', clue: 'Curved path one body takes around another', tier: 2, topic: 'space' },
  { word: 'VENUS', clue: 'Second planet out, and hotter than Mercury', tier: 2, topic: 'space' },
  { word: 'FLUTE', clue: 'Silver pipe held sideways and blown across', tier: 2, topic: 'music' },
  { word: 'PIANO', clue: 'Eighty-eight keys, black and white', tier: 2, topic: 'music' },
  { word: 'BANJO', clue: 'Twangy five-string with a drum-like body', tier: 2, topic: 'music' },
  { word: 'TEMPO', clue: 'How fast or slow a piece of music runs', tier: 2, topic: 'music' },
  { word: 'MEDAL', clue: 'Metal disc on a ribbon for a winner', tier: 2, topic: 'sport' },
  { word: 'ARENA', clue: 'Ring of seats around a sporting floor', tier: 2, topic: 'sport' },
  { word: 'RELAY', clue: 'Team race where a baton is handed on', tier: 2, topic: 'sport' },
  { word: 'CLOUD', clue: 'Floating mass of water droplets in the sky', tier: 2, topic: 'weather' },
  { word: 'STORM', clue: 'Violent weather of wind and heavy rain', tier: 2, topic: 'weather' },
  { word: 'SLEET', clue: 'Half-melted mix of rain and snow', tier: 2, topic: 'weather' },
  { word: 'THUMB', clue: 'Short fat digit that faces the fingers', tier: 2, topic: 'body' },
  { word: 'ELBOW', clue: 'Joint halfway along your arm', tier: 2, topic: 'body' },
  { word: 'WRIST', clue: 'Narrow joint between hand and forearm', tier: 2, topic: 'body' },
  { word: 'ANKLE', clue: 'Joint where your foot meets your leg', tier: 2, topic: 'body' },
  { word: 'SPINE', clue: 'Stack of small bones running down your back', tier: 2, topic: 'body' },
  { word: 'DRILL', clue: 'Spinning bit that bores a round hole', tier: 2, topic: 'tools' },
  { word: 'SPADE', clue: 'Flat blade on a handle for turning garden soil', tier: 2, topic: 'tools' },
  { word: 'LEVER', clue: 'Bar on a pivot that multiplies your push', tier: 2, topic: 'tools' },
  { word: 'AMBER', clue: 'Fossil tree resin, and the middle traffic light', tier: 2, topic: 'colours' },
  { word: 'IVORY', clue: 'Creamy white of tusks and old piano keys', tier: 2, topic: 'colours' },
  { word: 'CORAL', clue: 'Pinkish orange named after a reef builder', tier: 2, topic: 'colours' },
  { word: 'PRIDE', clue: 'Warm glow at your own success, or a group of lions', tier: 2, topic: 'emotions' },
  { word: 'SHAME', clue: 'Hot-cheeked feeling after doing wrong', tier: 2, topic: 'emotions' },
  { word: 'GRIEF', clue: 'Deep heavy sadness after a loss', tier: 2, topic: 'emotions' },
  { word: 'FERRY', clue: 'Boat that shuttles cars across the water', tier: 2, topic: 'travel' },
  { word: 'CANOE', clue: 'Slim open boat driven by a single-bladed paddle', tier: 2, topic: 'travel' },
  { word: 'YACHT', clue: 'Sleek pleasure sailboat with a tall mast', sentence: 'The ____ leaned over into the wind.', tier: 2, topic: 'travel', say: 'yot' },
  { word: 'FAIRY', clue: 'Tiny winged sprite at the bottom of the garden', tier: 2, topic: 'myth' },
  { word: 'WITCH', clue: 'Pointy-hatted caster of spells who rides a broom', tier: 2, topic: 'myth' },
  { word: 'GNOME', clue: 'Bearded little garden statue in a red cap', tier: 2, topic: 'myth', say: 'nome' },
  { word: 'SHARK', clue: 'Toothy fish with a triangular back fin', tier: 2, topic: 'ocean' },
  { word: 'WHALE', clue: 'Huge sea mammal that spouts from a blowhole', tier: 2, topic: 'ocean' },
  { word: 'SQUID', clue: 'Inky sea creature with eight arms and two tentacles', tier: 2, topic: 'ocean' },
  { word: 'PEARL', clue: 'Round gem grown inside an oyster', tier: 2, topic: 'ocean' },
  { word: 'PETAL', clue: 'Coloured flap around the middle of a flower', tier: 2, topic: 'plants' },
  { word: 'TULIP', clue: 'Cup-shaped spring bloom from a bulb, big in Holland', tier: 2, topic: 'plants' },
  { word: 'DAISY', clue: 'Small white lawn flower with a yellow eye', tier: 2, topic: 'plants' },
  { word: 'IGLOO', clue: 'Dome shelter built from blocks of snow', tier: 2, topic: 'buildings' },
  { word: 'ATTIC', clue: 'Dusty storage space just under the roof', tier: 2, topic: 'buildings' },
  { word: 'PORCH', clue: 'Covered entrance step at a front door', tier: 2, topic: 'buildings' },
  { word: 'CLOCK', clue: 'Round face with hands that tick', tier: 2, topic: 'time' },
  { word: 'EPOCH', clue: 'Long stretch of history with a name of its own', sentence: 'The ice age was one long cold ____.', tier: 2, topic: 'time', say: 'EE-pok' },
  { word: 'SCARF', clue: 'Long cloth wound around a cold neck', tier: 2, topic: 'clothing' },
  { word: 'GLOVE', clue: 'Hand cover with five fingery pockets', tier: 2, topic: 'clothing' },
  { word: 'SHIRT', clue: 'Buttoned top with a collar and cuffs', tier: 2, topic: 'clothing' },
  { word: 'MOTOR', clue: 'Device that turns electric power into movement', tier: 2, topic: 'machines' },
  { word: 'ROBOT', clue: 'Programmed machine that does a human job', tier: 2, topic: 'machines' },
  { word: 'WHEEL', clue: 'Round part that turns on an axle', tier: 2, topic: 'machines' },

  // ---------------------------------------------------------------- tier 3 --
  { word: 'BADGER', clue: 'Striped-faced night digger that lives in a sett', tier: 3, topic: 'animals' },
  { word: 'WEASEL', clue: 'Long skinny hunter of mice that slips down burrows', tier: 3, topic: 'animals' },
  { word: 'PARROT', clue: 'Bright tropical bird that copies your words', tier: 3, topic: 'animals' },
  { word: 'TURTLE', clue: 'Shelled reptile that swims and lays eggs on a beach', tier: 3, topic: 'animals' },
  { word: 'BEAVER', clue: 'Buck-toothed rodent that dams a stream with sticks', tier: 3, topic: 'animals' },
  { word: 'CANYON', clue: 'Deep gorge cut down through rock by a river', tier: 3, topic: 'nature' },
  { word: 'FOREST', clue: 'Wide area crowded with trees', tier: 3, topic: 'nature' },
  { word: 'DESERT', clue: 'Land that gets almost no rain all year', tier: 3, topic: 'nature' },
  { word: 'MEADOW', clue: 'Grassy field of wildflowers and buzzing bees', tier: 3, topic: 'nature' },
  { word: 'WALNUT', clue: 'Wrinkled brain-shaped kernel in a hard shell', tier: 3, topic: 'food' },
  { word: 'MUFFIN', clue: 'Small domed cake baked in a paper case', tier: 3, topic: 'food' },
  { word: 'GARLIC', clue: 'Pungent bulb of cloves said to ward off vampires', tier: 3, topic: 'food' },
  { word: 'SALMON', clue: 'Pink-fleshed fish that leaps upstream to spawn', tier: 3, topic: 'food' },
  { word: 'MAGNET', clue: 'Iron bar that grabs pins and points north', tier: 3, topic: 'science' },
  { word: 'VACUUM', clue: 'Empty space with no air in it at all', sentence: 'Sound cannot travel through a ____.', tier: 3, topic: 'science' },
  { word: 'CARBON', clue: 'Element found in diamond, graphite and all living things', tier: 3, topic: 'science' },
  { word: 'OXYGEN', clue: 'Gas making up about a fifth of the air we breathe', tier: 3, topic: 'science' },
  { word: 'GALAXY', clue: 'Vast island of billions of stars', tier: 3, topic: 'space' },
  { word: 'ROCKET', clue: 'Tube of fuel that pushes itself into space', tier: 3, topic: 'space' },
  { word: 'METEOR', clue: 'Streak of light from a dust grain burning up in the air', tier: 3, topic: 'space' },
  { word: 'CELLO', clue: 'Big bowed string player held between the knees', tier: 3, topic: 'music', say: 'CHEL-oh' },
  { word: 'OPERA', clue: 'Stage drama in which every line is sung', tier: 3, topic: 'music' },
  { word: 'OCTAVE', clue: 'Gap of eight notes from one C up to the next', sentence: 'Her voice jumped a whole ____.', tier: 3, topic: 'music' },
  { word: 'HURDLE', clue: 'Barrier a sprinter leaps in a track race', tier: 3, topic: 'sport' },
  { word: 'SPRINT', clue: 'Flat-out dash over a very short distance', tier: 3, topic: 'sport' },
  { word: 'TENNIS', clue: 'Racket game over a net, scored love to forty', tier: 3, topic: 'sport' },
  { word: 'BREEZE', clue: 'Gentle wind that stirs the curtains', tier: 3, topic: 'weather' },
  { word: 'SHOWER', clue: 'Brief burst of rain, or a morning wash', tier: 3, topic: 'weather' },
  { word: 'MUSCLE', clue: 'Meaty tissue that contracts to pull on a bone', tier: 3, topic: 'body' },
  { word: 'KIDNEY', clue: 'Bean-shaped filter that makes urine', tier: 3, topic: 'body' },
  { word: 'TENDON', clue: 'Tough cord tying meat to bone', tier: 3, topic: 'body' },
  { word: 'SKULL', clue: 'Bony helmet around your brain', tier: 3, topic: 'body' },
  { word: 'HAMMER', clue: 'Heavy head on a handle for driving nails', tier: 3, topic: 'tools' },
  { word: 'WRENCH', clue: 'Jawed metal tool for turning a nut', tier: 3, topic: 'tools' },
  { word: 'CHISEL', clue: 'Sharp-edged bar tapped to carve wood or stone', tier: 3, topic: 'tools' },
  { word: 'SHOVEL', clue: 'Curved scoop on a long shaft for shifting coal', tier: 3, topic: 'tools' },
  { word: 'MAROON', clue: 'Dark brownish red, or to strand on an island', tier: 3, topic: 'colours' },
  { word: 'VIOLET', clue: 'Bluish purple at the far end of the rainbow', tier: 3, topic: 'colours' },
  { word: 'SILVER', clue: 'Shiny grey metal, and the second place finish', tier: 3, topic: 'colours' },
  { word: 'SORROW', clue: 'Heavy sadness that weighs on the heart', tier: 3, topic: 'emotions' },
  { word: 'WONDER', clue: 'Open-mouthed awe at something amazing', tier: 3, topic: 'emotions' },
  { word: 'REGRET', clue: 'Wish that you had acted differently', tier: 3, topic: 'emotions' },
  { word: 'TUNNEL', clue: 'Passage bored under a hill or a river', tier: 3, topic: 'travel' },
  { word: 'VOYAGE', clue: 'Long journey made across the sea', tier: 3, topic: 'travel' },
  { word: 'SPHINX', clue: 'Riddling lion with a human head', tier: 3, topic: 'myth' },
  { word: 'MEDUSA', clue: 'Snake-haired gaze that turned men to stone', sentence: 'One look from ____ turned you to stone.', tier: 3, topic: 'myth' },
  { word: 'WIZARD', clue: 'Robed spell caster with a staff and a long beard', tier: 3, topic: 'myth' },
  { word: 'KRAKEN', clue: 'Legendary tentacled beast that drags ships under', tier: 3, topic: 'myth', say: 'KRAK-en' },
  { word: 'LAGOON', clue: 'Shallow salt pool cut off by a coral ridge', tier: 3, topic: 'ocean' },
  { word: 'OYSTER', clue: 'Rough two-shelled creature slurped raw', tier: 3, topic: 'ocean' },
  { word: 'SPONGE', clue: 'Holey sea animal that soaks up bath water', tier: 3, topic: 'ocean' },
  { word: 'ANCHOR', clue: 'Heavy hook dropped to hold a boat still', sentence: 'They dropped ____ in the quiet bay.', tier: 3, topic: 'ocean' },
  { word: 'BAMBOO', clue: 'Fast-growing hollow grass that pandas eat', tier: 3, topic: 'plants' },
  { word: 'ORCHID', clue: 'Exotic bloom with a lip-shaped lower petal', tier: 3, topic: 'plants' },
  { word: 'CLOVER', clue: 'Three-leafed lawn plant, lucky if you find a fourth', tier: 3, topic: 'plants' },
  { word: 'POLLEN', clue: 'Yellow flower dust carried about by bees', tier: 3, topic: 'plants' },
  { word: 'CASTLE', clue: 'Stone stronghold with towers and a moat', tier: 3, topic: 'buildings' },
  { word: 'BRIDGE', clue: 'Span carrying a road over water', tier: 3, topic: 'buildings' },
  { word: 'TEMPLE', clue: 'Building raised for worship, or the side of your head', tier: 3, topic: 'buildings' },
  { word: 'MUSEUM', clue: 'Hall of old objects laid out in glass cases', tier: 3, topic: 'buildings' },
  { word: 'MINUTE', clue: 'Sixty ticks of the clock', tier: 3, topic: 'time' },
  { word: 'SECOND', clue: 'One tick of a clock, or the place just after first', tier: 3, topic: 'time' },
  { word: 'AUTUMN', clue: 'Season when leaves turn brown and drop', tier: 3, topic: 'time' },
  { word: 'JACKET', clue: 'Short coat with sleeves and a zip', tier: 3, topic: 'clothing' },
  { word: 'MITTEN', clue: 'Hand warmer with one pouch for four fingers', tier: 3, topic: 'clothing' },
  { word: 'SANDAL', clue: 'Open summer shoe held on by straps', tier: 3, topic: 'clothing' },
  { word: 'HELMET', clue: 'Hard shell worn to protect the head', tier: 3, topic: 'clothing' },
  { word: 'ENGINE', clue: 'Machine that burns fuel to make a car go', tier: 3, topic: 'machines' },
  { word: 'PISTON', clue: 'Rod that slides up and down inside a cylinder', tier: 3, topic: 'machines' },
  { word: 'BOILER', clue: 'Tank that heats the water for the radiators', sentence: 'The ____ broke and the taps ran cold.', tier: 3, topic: 'machines' },

  // ---------------------------------------------------------------- tier 4 --
  { word: 'PENGUIN', clue: 'Tuxedoed bird that swims well but cannot fly', tier: 4, topic: 'animals' },
  { word: 'GIRAFFE', clue: 'Tallest land animal, blotched and long of neck', tier: 4, topic: 'animals' },
  { word: 'LEOPARD', clue: 'Spotted big cat that hauls its kill up a tree', tier: 4, topic: 'animals' },
  { word: 'SQUIRREL', clue: 'Bushy-tailed nut burier of the park', tier: 4, topic: 'animals' },
  { word: 'HEDGEHOG', clue: 'Spiny night forager that curls into a prickly ball', tier: 4, topic: 'animals' },
  { word: 'GLACIER', clue: 'River of ice that grinds down a valley', tier: 4, topic: 'nature' },
  { word: 'VOLCANO', clue: 'Mountain that erupts with molten rock and ash', tier: 4, topic: 'nature' },
  { word: 'MOUNTAIN', clue: 'Land rising to a peak far above the plain', tier: 4, topic: 'nature' },
  { word: 'CINNAMON', clue: 'Curled bark spice sprinkled over buns', tier: 4, topic: 'food' },
  { word: 'BROCCOLI', clue: 'Green vegetable shaped like a bunch of tiny trees', tier: 4, topic: 'food' },
  { word: 'PANCAKE', clue: 'Flat batter disc flipped in a hot pan', tier: 4, topic: 'food' },
  { word: 'PUMPKIN', clue: 'Orange gourd carved with a face in October', tier: 4, topic: 'food' },
  { word: 'MOLECULE', clue: 'Group of atoms bonded together as one unit', tier: 4, topic: 'science' },
  { word: 'PENDULUM', clue: 'Swinging weight that keeps an old clock in time', sentence: 'The ____ swung slowly behind the glass.', tier: 4, topic: 'science' },
  { word: 'FRICTION', clue: 'Drag between two surfaces that rub together', sentence: 'Oil in the bearings cuts down ____.', tier: 4, topic: 'science' },
  { word: 'CRYSTAL', clue: 'Solid whose atoms sit in a repeating pattern', tier: 4, topic: 'science' },
  { word: 'ASTEROID', clue: 'Rocky lump circling mostly between Mars and Jupiter', tier: 4, topic: 'space' },
  { word: 'ECLIPSE', clue: 'When one sky-body slides into the shadow of another', sentence: 'Crowds watched the ____ through dark glasses.', tier: 4, topic: 'space' },
  { word: 'MERCURY', clue: 'Closest planet to the sun, and a liquid metal', tier: 4, topic: 'space' },
  { word: 'TRUMPET', clue: 'Brass horn with three valves and a flared bell', tier: 4, topic: 'music' },
  { word: 'CLARINET', clue: 'Black woodwind played with a single reed', tier: 4, topic: 'music' },
  { word: 'SYMPHONY', clue: 'Long orchestral work in several movements', tier: 4, topic: 'music' },
  { word: 'RHYTHM', clue: 'The beat pattern your foot taps along to', sentence: 'The drummer kept a steady ____.', tier: 4, topic: 'music' },
  { word: 'MARATHON', clue: 'Road race of twenty-six miles and a bit', tier: 4, topic: 'sport' },
  { word: 'STADIUM', clue: 'Big bowl of seats around a playing pitch', tier: 4, topic: 'sport' },
  { word: 'PENALTY', clue: 'Punishment kick awarded for a foul in the box', tier: 4, topic: 'sport' },
  { word: 'TORNADO', clue: 'Spinning funnel of wind that rips up a farmhouse', tier: 4, topic: 'weather' },
  { word: 'BLIZZARD', clue: 'Howling snowstorm that blinds you', sentence: 'The mountain road closed in the ____.', tier: 4, topic: 'weather' },
  { word: 'FORECAST', clue: 'Prediction of what the weather will do tomorrow', tier: 4, topic: 'weather' },
  { word: 'SKELETON', clue: 'The full frame of bones inside you', tier: 4, topic: 'body' },
  { word: 'STOMACH', clue: 'Acid bag where a swallowed meal is churned', tier: 4, topic: 'body' },
  { word: 'KNUCKLE', clue: 'Bumpy finger joint that shows when you make a fist', sentence: 'He grazed a ____ on the brick wall.', tier: 4, topic: 'body' },
  { word: 'SCISSORS', clue: 'Two crossed blades hinged to snip paper', sentence: 'Cut along the dotted line with the ____.', tier: 4, topic: 'tools' },
  { word: 'TWEEZERS', clue: 'Tiny pincers for plucking out a splinter', tier: 4, topic: 'tools' },
  { word: 'LAVENDER', clue: 'Pale purple, and a fragrant garden herb', tier: 4, topic: 'colours' },
  { word: 'CHARCOAL', clue: 'Black burnt wood used to sketch or to grill', tier: 4, topic: 'colours' },
  { word: 'ANXIETY', clue: 'Knot of worry about what might happen', tier: 4, topic: 'emotions' },
  { word: 'JEALOUSY', clue: 'Bitter fear that someone will take what is yours', tier: 4, topic: 'emotions' },
  { word: 'OPTIMISM', clue: 'Sunny belief that things will turn out well', tier: 4, topic: 'emotions' },
  { word: 'PASSPORT', clue: 'Booklet stamped when you cross a border', tier: 4, topic: 'travel' },
  { word: 'SUITCASE', clue: 'Wheeled box packed for a holiday', tier: 4, topic: 'travel' },
  { word: 'CARAVAN', clue: 'Home on wheels towed behind a car', tier: 4, topic: 'travel' },
  { word: 'UNICORN', clue: 'White horse of legend with one spiral horn', tier: 4, topic: 'myth' },
  { word: 'VAMPIRE', clue: 'Fanged night stalker who fears garlic and daylight', tier: 4, topic: 'myth' },
  { word: 'MINOTAUR', clue: 'Bull-headed man kept inside a maze', sentence: 'Theseus fought the ____ in the dark.', tier: 4, topic: 'myth' },
  { word: 'GARGOYLE', clue: 'Carved stone monster that spouts water off a roof', tier: 4, topic: 'myth' },
  { word: 'BARNACLE', clue: 'Crusty little shell glued to the hull of a ship', tier: 4, topic: 'ocean' },
  { word: 'SEAHORSE', clue: 'Curly-tailed fish whose male carries the young', tier: 4, topic: 'ocean' },
  { word: 'ANEMONE', clue: 'Stinging flower-like creature in a rock pool', sentence: 'A clownfish hid inside the ____.', tier: 4, topic: 'ocean', say: 'uh-NEM-uh-nee' },
  { word: 'STINGRAY', clue: 'Flat gliding fish with a barbed whip of a tail', tier: 4, topic: 'ocean' },
  { word: 'BLOSSOM', clue: 'Cloud of pink petals on a fruit tree in spring', tier: 4, topic: 'plants' },
  { word: 'THISTLE', clue: 'Prickly purple-headed weed, the badge of Scotland', tier: 4, topic: 'plants' },
  { word: 'SEEDLING', clue: 'Baby plant just poking out of the soil', sentence: 'A tiny ____ pushed up through the soil.', tier: 4, topic: 'plants' },
  { word: 'PYRAMID', clue: 'Four-sided tomb rising to a point in Egypt', tier: 4, topic: 'buildings' },
  { word: 'BALCONY', clue: 'Small railed platform off an upstairs window', tier: 4, topic: 'buildings' },
  { word: 'CHIMNEY', clue: 'Brick flue that carries smoke up and away', tier: 4, topic: 'buildings' },
  { word: 'FORTRESS', clue: 'Thickly walled place built to resist attack', tier: 4, topic: 'buildings' },
  { word: 'CALENDAR', clue: 'Grid of dates you hang on the wall', tier: 4, topic: 'time' },
  { word: 'TWILIGHT', clue: 'Dim glow lingering after the sun has gone', tier: 4, topic: 'time' },
  { word: 'EQUINOX', clue: 'Day of equal light and dark, and it happens twice a year', sentence: 'Day and night are the same length at the ____.', tier: 4, topic: 'time' },
  { word: 'CARDIGAN', clue: 'Knitted woolly top that buttons up the front', tier: 4, topic: 'clothing' },
  { word: 'UMBRELLA', clue: 'Folding canopy on a stick for wet days', tier: 4, topic: 'clothing' },
  { word: 'NECKLACE', clue: 'String of beads worn at the throat', tier: 4, topic: 'clothing' },
  { word: 'ELEVATOR', clue: 'Box on cables that lifts you between floors', tier: 4, topic: 'machines' },
  { word: 'TRACTOR', clue: 'Big-wheeled farm machine that pulls a plough', tier: 4, topic: 'machines' },
  { word: 'COMPUTER', clue: 'Machine with a keyboard that runs programs', tier: 4, topic: 'machines' },

  // ---------------------------------------------------------------- tier 5 --
  { word: 'BUREAUCRACY', clue: 'A system of forms, stamps and offices that slows everything down', sentence: 'Getting a permit meant weeks of ____.', tier: 5, topic: 'buildings', say: 'byoo-ROK-ruh-see' },
  { word: 'CONSCIENCE', clue: 'The inner voice telling you right from wrong', sentence: 'A guilty ____ kept him awake.', tier: 5, topic: 'emotions' },
  { word: 'MISCHIEVOUS', clue: 'Playfully naughty and always up to tricks', sentence: 'The ____ pup hid both of my shoes.', tier: 5, topic: 'emotions', say: 'MISS-chiv-us' },
  { word: 'ONOMATOPOEIA', clue: 'Words like buzz and splash that imitate the sound', sentence: 'Sizzle and clang are examples of ____.', tier: 5, topic: 'music', say: 'on-oh-mat-oh-PEE-uh' },
  { word: 'RESTAURANT', clue: 'Place where waiters bring you a menu', sentence: 'We booked a table at the new ____.', tier: 5, topic: 'food' },
  { word: 'NECESSARY', clue: 'Absolutely required and cannot be gone without', sentence: 'Water is ____ on a long hike.', tier: 5, topic: 'travel' },
  { word: 'EMBARRASS', clue: 'To make someone go red with awkwardness', sentence: 'Please do not ____ me in front of my friends.', tier: 5, topic: 'emotions' },
  { word: 'SILHOUETTE', clue: 'Solid dark outline of a shape against the light', sentence: 'His ____ showed black against the sunset.', tier: 5, topic: 'colours', say: 'sil-oo-ET' },
  { word: 'CHLOROPHYLL', clue: 'Green pigment letting a leaf trap sunlight', sentence: 'Leaves look green because of ____.', tier: 5, topic: 'science', say: 'KLOR-uh-fill' },
  { word: 'MICROSCOPE', clue: 'Lens tube for viewing things far too small to see', tier: 5, topic: 'science' },
  { word: 'THERMOMETER', clue: 'Instrument with a scale reading how hot something is', sentence: 'The nurse put a ____ under my tongue.', tier: 5, topic: 'science' },
  { word: 'ELECTRICITY', clue: 'Flow of charge along a wire that lights a bulb', sentence: 'The storm cut off our ____ for a day.', tier: 5, topic: 'science' },
  { word: 'ASTRONAUT', clue: 'Person who works in orbit in a bulky white suit', sentence: 'The ____ floated slowly out of the hatch.', tier: 5, topic: 'space' },
  { word: 'TELESCOPE', clue: 'Long tube of lenses aimed at distant worlds', tier: 5, topic: 'space' },
  { word: 'SUPERNOVA', clue: 'Colossal blast that ends the life of a giant star', sentence: 'Telescopes caught a ____ in a far off galaxy.', tier: 5, topic: 'space' },
  { word: 'AVALANCHE', clue: 'Mass of snow thundering down a mountainside', sentence: 'A single shout can be enough to start an ____.', tier: 5, topic: 'nature' },
  { word: 'WATERFALL', clue: 'Where a river drops off a cliff edge', sentence: 'Mist rose from the foot of the ____.', tier: 5, topic: 'nature' },
  { word: 'RAINFOREST', clue: 'Steamy jungle where it pours nearly every day', tier: 5, topic: 'nature' },
  { word: 'SPAGHETTI', clue: 'Long thin strings of pasta twirled on a fork', sentence: 'She twirled the ____ around her fork.', tier: 5, topic: 'food' },
  { word: 'CHOCOLATE', clue: 'Brown cocoa treat that melts in your mouth', tier: 5, topic: 'food' },
  { word: 'PINEAPPLE', clue: 'Spiky tropical fruit with a crown of leaves', tier: 5, topic: 'food' },
  { word: 'MAYONNAISE', clue: 'Creamy egg and oil sauce spread in sandwiches', sentence: 'He spread ____ on both slices.', tier: 5, topic: 'food' },
  { word: 'ORCHESTRA', clue: 'Large group of players led by a conductor', sentence: 'The ____ tuned up before the curtain rose.', tier: 5, topic: 'music' },
  { word: 'SAXOPHONE', clue: 'Curved metal woodwind that wails through jazz', tier: 5, topic: 'music' },
  { word: 'CRESCENDO', clue: 'Gradual swell from quiet to loud in music', sentence: 'The drums built to a thundering ____.', tier: 5, topic: 'music', say: 'kruh-SHEN-doh' },
  { word: 'XYLOPHONE', clue: 'Row of wooden bars struck with small mallets', sentence: 'She picked out a tune on the ____.', tier: 5, topic: 'music' },
  { word: 'GYMNASTICS', clue: 'Sport of vaults, beams and floor tumbling', tier: 5, topic: 'sport' },
  { word: 'TOURNAMENT', clue: 'Knockout series played to find one champion', tier: 5, topic: 'sport' },
  { word: 'HURRICANE', clue: 'Huge spiralling Atlantic storm with a calm eye', sentence: 'The ____ tore the roof off the shed.', tier: 5, topic: 'weather' },
  { word: 'LIGHTNING', clue: 'Jagged electric flash from cloud to ground', sentence: 'A fork of ____ lit up the whole field.', tier: 5, topic: 'weather' },
  { word: 'THUNDERSTORM', clue: 'Downpour with bright flashes and loud rumbles', sentence: 'We sheltered in the barn during the ____.', tier: 5, topic: 'weather' },
  { word: 'CIRCULATION', clue: 'The looping of blood around the body', tier: 5, topic: 'body' },
  { word: 'FINGERNAIL', clue: 'Hard plate at the tip of a digit', tier: 5, topic: 'body' },
  { word: 'ENTHUSIASM', clue: 'Bouncing eagerness for a thing you love', tier: 5, topic: 'emotions' },
  { word: 'FRUSTRATION', clue: 'Fizzing annoyance when nothing will work', sentence: 'He kicked the door in ____.', tier: 5, topic: 'emotions' },
  { word: 'GRATITUDE', clue: 'Warm thankfulness for a kindness done to you', sentence: 'She wrote a note of ____ to the driver.', tier: 5, topic: 'emotions' },
  { word: 'EXPEDITION', clue: 'Organised journey to explore somewhere wild', sentence: 'The polar ____ set off in March.', tier: 5, topic: 'travel' },
  { word: 'LABYRINTH', clue: 'Twisting maze of passages you get lost inside', sentence: 'The tunnels below the city form a ____.', tier: 5, topic: 'myth' },
  { word: 'WEREWOLF', clue: 'Human who turns hairy under a full moon', tier: 5, topic: 'myth' },
  { word: 'SUBMARINE', clue: 'Vessel that dives and travels below the waves', tier: 5, topic: 'ocean' },
  { word: 'JELLYFISH', clue: 'Drifting see-through blob with stinging threads', sentence: 'A ____ stung my ankle in the shallows.', tier: 5, topic: 'ocean' },
  { word: 'CRUSTACEAN', clue: 'Hard-shelled group that takes in crabs and lobsters', sentence: 'A prawn is a small ____.', tier: 5, topic: 'ocean' },
  { word: 'DANDELION', clue: 'Yellow lawn weed whose seed clock you blow away', sentence: 'He blew the white clock off the ____.', tier: 5, topic: 'plants' },
  { word: 'SUNFLOWER', clue: 'Tall yellow bloom grown for its oily black seeds', tier: 5, topic: 'plants' },
  { word: 'EUCALYPTUS', clue: 'Tall gum tree whose leaves feed koalas', sentence: 'The koala dozed high in a ____.', tier: 5, topic: 'plants', say: 'yoo-kuh-LIP-tus' },
  { word: 'CATHEDRAL', clue: 'Grand church that seats a bishop', sentence: 'The choir sang inside the great ____.', tier: 5, topic: 'buildings' },
  { word: 'SKYSCRAPER', clue: 'Tower of glass and steel with dozens of floors', sentence: 'The lift climbed sixty floors of the ____.', tier: 5, topic: 'buildings' },
  { word: 'LIGHTHOUSE', clue: 'Coastal tower with a sweeping warning beam', tier: 5, topic: 'buildings' },
  { word: 'MILLENNIUM', clue: 'A thousand years counted as one span', sentence: 'The castle has stood for over a ____.', tier: 5, topic: 'time' },
  { word: 'ANNIVERSARY', clue: 'Yearly return of a date worth marking', tier: 5, topic: 'time' },
  { word: 'WARDROBE', clue: 'Tall cupboard where clothes hang on a rail', tier: 5, topic: 'clothing' },
  { word: 'HELICOPTER', clue: 'Aircraft lifted by whirling blades on top', tier: 5, topic: 'machines' },
  { word: 'REFRIGERATOR', clue: 'Humming cold box that keeps the milk fresh', sentence: 'Put the butter back in the ____.', tier: 5, topic: 'machines' },
  { word: 'TURQUOISE', clue: 'Blue-green of a tropical sea and of a gemstone', sentence: 'The lagoon was a bright ____.', tier: 5, topic: 'colours', say: 'TUR-koyz' },
  { word: 'CHIMPANZEE', clue: 'Clever African ape that uses twigs as tools', tier: 5, topic: 'animals' },
  { word: 'RHINOCEROS', clue: 'Thick-skinned grazer with a horn on its nose', sentence: 'The ____ charged off across the dust.', tier: 5, topic: 'animals' },
];

/** Sane word-length window per tier; used by both authoring and validation. */
const TIER_LENGTHS: Record<number, [min: number, max: number]> = {
  1: [3, 4],
  2: [4, 5],
  3: [5, 6],
  4: [6, 8],
  5: [8, 12],
};

/** All entries for a tier. */
export function wordsByTier(tier: number): WordEntry[] {
  return WORDS.filter((w) => w.tier === tier);
}

/** Every distinct letter used across the bank, for building letter walls. */
export const ALPHABET: string[] = [...new Set(WORDS.flatMap((w) => w.word.split('')))].sort();

/**
 * A declarative slice of the bank.
 *
 * Every field is optional and every present field is ANDed, so `{}` means the
 * whole bank and `{ topics: ['ocean'], tiers: [2, 3] }` means "ocean words at
 * tiers 2 and 3". This is what a level descriptor carries instead of a tier
 * number — see `src/game/levels.ts`.
 */
export interface WordQuery {
  /** Difficulty tiers to draw from. */
  tiers?: readonly number[];
  /** Topic tags to draw from, matched exactly against `WordEntry.topic`. */
  topics?: readonly string[];
  /** Specific words, uppercase. Useful for a hand-authored set piece. */
  ids?: readonly string[];
  /** Letter-count window, inclusive. */
  minLen?: number;
  maxLen?: number;
}

/**
 * Resolve a query against the bank.
 *
 * Called once when a level is resolved, never per frame — the result is the
 * level's word pool for its whole run.
 */
export function queryWords(q: WordQuery): WordEntry[] {
  const out: WordEntry[] = [];
  for (const w of WORDS) {
    if (q.tiers && q.tiers.indexOf(w.tier) < 0) continue;
    if (q.topics && q.topics.indexOf(w.topic) < 0) continue;
    if (q.ids && q.ids.indexOf(w.word) < 0) continue;
    if (q.minLen !== undefined && w.word.length < q.minLen) continue;
    if (q.maxLen !== undefined && w.word.length > q.maxLen) continue;
    out.push(w);
  }
  return out;
}

/** The distinct tiers present in a set of entries, ascending. */
export function tiersIn(entries: readonly WordEntry[]): number[] {
  const seen: number[] = [];
  for (const w of entries) if (seen.indexOf(w.tier) < 0) seen.push(w.tier);
  return seen.sort((a, b) => a - b);
}

/** Every topic tag in the bank, alphabetical. Handy when authoring a level. */
export const TOPICS: string[] = [...new Set(WORDS.map((w) => w.topic))].sort();

/** Validated at module load in dev: throws if any entry breaks the rules. */
export function validateWordBank(): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const entry of WORDS) {
    const { word, clue, tier } = entry;

    if (!/^[A-Z]{3,12}$/.test(word)) {
      problems.push(`${word}: not 3-12 uppercase letters`);
      continue;
    }

    if (seen.has(word)) problems.push(`${word}: duplicate entry`);
    seen.add(word);

    const lower = clue.toLowerCase();
    if (lower.includes(word.toLowerCase())) {
      problems.push(`${word}: clue contains the word`);
    } else if (lower.includes(word.slice(0, 4).toLowerCase())) {
      problems.push(`${word}: clue contains the first four letters`);
    }

    if (clue.length < 15 || clue.length > 90) {
      problems.push(`${word}: clue is ${clue.length} chars, want 15-90`);
    }

    const range = TIER_LENGTHS[tier];
    if (!range) {
      problems.push(`${word}: unknown tier ${tier}`);
    } else if (word.length < range[0] || word.length > range[1]) {
      problems.push(`${word}: length ${word.length} outside tier ${tier} range ${range[0]}-${range[1]}`);
    }

    if (entry.sentence && !entry.sentence.includes('____')) {
      problems.push(`${word}: sentence has no ____ blank`);
    }
  }

  return problems;
}
