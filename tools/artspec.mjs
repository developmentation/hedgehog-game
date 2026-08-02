/**
 * Generated-art manifest.
 *
 * Every asset shares one STYLE preamble. That shared preamble is what makes
 * two dozen independently-generated images read as a single art direction
 * rather than a pile of stock assets — it fixes the lighting direction, the
 * palette, the paint treatment and the camera, and each asset prompt only
 * describes the subject.
 *
 * Assets are generated on flat chroma and keyed by tools/matte.mjs. The key
 * colour is chosen per-asset to be a colour that cannot occur in the subject:
 * magenta for foliage/stone/sky work, green for anything warm or pink.
 */

/** Locked art direction. Changing this invalidates the whole set. */
export const STYLE = [
  'Hand-painted 2D video-game asset in the style of a modern premium side-scrolling platformer.',
  'Rich painterly illustration with visible confident brushwork, deep saturated colour, and strong tonal separation between light and shadow.',
  'Lighting: a low warm golden sun from the RIGHT side, producing warm amber rim-light on right-facing edges and deep cool blue-violet shadows on the left.',
  'Palette: teal and blue-violet shadows, warm amber and coral highlights, high colour contrast, cinematic dusk mood.',
  'Rendered in clean orthographic side view as if photographed straight-on for a 2D game layer, no perspective distortion, no vanishing point.',
  'Crisp readable silhouette. Sharp clean edges. No blur, no depth-of-field, no bokeh, no lens flare.',
  'No text, no letters, no numbers, no watermark, no signature, no UI, no border, no frame.',
  'Wholly original design. Do not imitate, reference or resemble any existing video-game character, mascot or franchise.',
].join(' ');

/**
 * Extra guard for the hero sprites.
 *
 * A "cartoon hedgehog game mascot" prompt collapses straight onto Sonic — the
 * first generation came back with red-and-white running shoes in a Sonic run
 * pose. These clauses name the specific traits to avoid, which is far more
 * effective than a generic "be original" instruction.
 */
export const HERO_ORIGINALITY = [
  'CRITICAL: this must not resemble Sonic the Hedgehog in any way.',
  'The character is barefoot with small natural paws — absolutely no shoes, no sneakers, no boots, no red footwear, no white straps or buckles.',
  'Not blue. Quills are indigo-purple with warm amber tips.',
  'No gloves. No attitude smirk. No green eyes, no joined single eye-band.',
  'The quills are short, soft and swept back like a real hedgehog, not long dramatic spikes.',
  'The body is rounded and small like a real hedgehog, not a slim humanoid figure.',
].join(' ');

/** Appended to every asset that must be keyed out. */
export const chromaClause = (colorName, hex) =>
  [
    `The subject is isolated on a completely flat, uniform, edge-to-edge pure ${colorName} background (hex ${hex}).`,
    'The background is a single solid colour with absolutely no gradient, texture, pattern, shading, vignette, glow or cast shadow.',
    `Nothing in the subject itself is ${colorName} or any near-${colorName} hue.`,
    'The subject is fully within frame and is not cropped or touching the image edges.',
  ].join(' ');

const MAGENTA = { name: 'magenta', hex: 'FF00FF', key: { r: 255, g: 0, b: 255 } };
const GREEN = { name: 'chroma green', hex: '00FF00', key: { r: 0, g: 255, b: 0 } };

/**
 * @typedef {object} AssetSpec
 * @property {string} id            output filename stem
 * @property {string} group         logical group, drives loading + layering
 * @property {string} subject       what to draw
 * @property {'1024x1024'|'1536x1024'|'1024x1536'} size
 * @property {object} [chroma]      key colour; omit for opaque full-frame art
 * @property {number} [maxDim]      downscale longest edge after matting
 * @property {number} [tolerance]   matte tolerance override
 */

/** @type {AssetSpec[]} */
export const ASSETS = [
  // ---------------------------------------------------------------- sky
  {
    id: 'sky_dusk',
    group: 'sky',
    subject:
      'An empty dusk sky for a game background. A smooth vertical gradient from deep indigo-blue at the top, through violet and rose, to a warm glowing amber band at the horizon at the bottom. A few soft wispy high-altitude cloud streaks catching warm light. Nothing else in frame: no ground, no hills, no trees, no birds, no sun disc.',
    size: '1536x1024',
    opaque: true,
  },

  // ------------------------------------------------------- distant layer
  {
    id: 'mountains_far',
    group: 'far',
    subject:
      'A long horizontal range of distant mountain peaks in flat atmospheric silhouette, seen from far away. Hazy pale blue-violet, very low contrast and low detail, as a far background layer. The range spans the full width of the image with varied peak heights. Flat bottom edge. No trees, no buildings, no snow detail.',
    size: '1536x1024',
    chroma: MAGENTA,
    maxDim: 1400,
  },
  {
    id: 'hills_mid',
    group: 'mid',
    subject:
      'A long horizontal band of rolling forested hills in mid-distance silhouette, dusty blue-teal, with a soft warm rim of light along the top ridge line. Simple treeline texture along the crest, low internal detail. Spans the full width of the image with a flat bottom edge.',
    size: '1536x1024',
    chroma: MAGENTA,
    maxDim: 1400,
  },

  // -------------------------------------------------------------- trees
  {
    id: 'tree_oak',
    group: 'prop',
    subject:
      'A single large ancient broadleaf tree with a thick gnarled twisting trunk, spreading root buttresses at the base, and dense layered rounded canopy foliage. Full tree, standing upright, base of the trunk at the bottom of frame.',
    size: '1024x1536',
    chroma: MAGENTA,
    maxDim: 1100,
  },
  {
    id: 'tree_pine',
    group: 'prop',
    subject:
      'A single tall slender conifer pine tree with layered drooping dark needled branches and a narrow pointed top. Full tree, standing upright, trunk base at the bottom of frame.',
    size: '1024x1536',
    chroma: MAGENTA,
    maxDim: 1100,
  },
  {
    id: 'tree_willow',
    group: 'prop',
    subject:
      'A single weeping willow tree with a short thick leaning trunk and long trailing curtains of hanging leaf strands cascading downward. Full tree, standing upright, trunk base at the bottom of frame.',
    size: '1024x1536',
    chroma: MAGENTA,
    maxDim: 1100,
  },
  {
    id: 'tree_birch_cluster',
    group: 'prop',
    subject:
      'A cluster of three slender pale-barked birch trees of different heights growing close together, with sparse delicate golden foliage at the top. Full trees, standing upright, trunk bases at the bottom of frame.',
    size: '1024x1536',
    chroma: MAGENTA,
    maxDim: 1100,
  },

  // ------------------------------------------------------------- ground
  {
    id: 'ground_slab',
    group: 'ground',
    subject:
      'A long horizontal slab of grassy earth seen from the side, like a cross-section of ground for a platformer. The top surface is lush dark green grass with a soft warm-lit upper edge and small tufts. Below is layered rocky soil with embedded stones, roots and strata, fading darker toward the bottom. Spans the full width of the image, flat left and right edges, flat bottom edge.',
    size: '1536x1024',
    chroma: MAGENTA,
    maxDim: 1400,
  },
  {
    id: 'grass_tuft_a',
    group: 'foreground',
    subject:
      'A small clump of tall wild grass blades and a few slender wildflower stems, fanning upward and outward. Bases gathered together at the bottom of frame.',
    size: '1024x1024',
    chroma: MAGENTA,
    maxDim: 460,
  },
  {
    id: 'grass_tuft_b',
    group: 'foreground',
    subject:
      'A wide low clump of soft meadow grass and small round leafy plants, spreading sideways. Bases gathered at the bottom of frame.',
    size: '1024x1024',
    chroma: MAGENTA,
    maxDim: 460,
  },
  {
    id: 'fern_cluster',
    group: 'foreground',
    subject:
      'A cluster of large arching fern fronds with detailed feathery leaflets, spreading up and outward from a common base at the bottom of frame.',
    size: '1024x1024',
    chroma: MAGENTA,
    maxDim: 520,
  },

  // -------------------------------------------------------------- props
  {
    id: 'bush_round',
    group: 'prop',
    subject:
      'A single dense rounded leafy shrub with layered foliage clumps and a few small berries. Sitting flat on its base at the bottom of frame.',
    size: '1024x1024',
    chroma: MAGENTA,
    maxDim: 560,
  },
  {
    id: 'rock_mossy',
    group: 'prop',
    subject:
      'A single large weathered boulder with angular chipped facets and patches of moss along its top and crevices. Resting flat on its base at the bottom of frame.',
    size: '1024x1024',
    chroma: MAGENTA,
    maxDim: 560,
  },
  {
    id: 'rock_small_pair',
    group: 'prop',
    subject:
      'Two small weathered stones of different sizes resting side by side on flat ground, with a few pebbles around them. Bases at the bottom of frame.',
    size: '1024x1024',
    chroma: MAGENTA,
    maxDim: 420,
  },
  {
    id: 'ruin_arch',
    group: 'prop',
    subject:
      'A crumbling ancient stone archway, partly broken at the top, with carved weathered blocks, cracks, and creeping vines growing over one side. Standing upright on its base at the bottom of frame.',
    size: '1024x1536',
    chroma: MAGENTA,
    maxDim: 900,
  },
  {
    id: 'ruin_pillar',
    group: 'prop',
    subject:
      'A broken ancient stone pillar, snapped off near the top, with fluted carved sides, chipped edges and moss at the base. Standing upright on its base at the bottom of frame.',
    size: '1024x1536',
    chroma: MAGENTA,
    maxDim: 780,
  },
  {
    id: 'mushroom_cluster',
    group: 'prop',
    subject:
      'A cluster of oversized fantasy mushrooms of varying heights with broad domed caps, pale glowing gills underneath, and thick pale stalks. Bases at the bottom of frame.',
    size: '1024x1024',
    chroma: MAGENTA,
    maxDim: 560,
  },

  // ------------------------------------------------- overhead / vertical mass
  {
    id: 'canopy_overhang',
    group: 'canopy',
    subject:
      'A dense band of leafy tree canopy seen from below, hanging DOWNWARD from the top edge of the frame. Layered clusters of foliage and a few thin drooping branches reach down into the middle of the image, with the leaves silhouetted dark against the light. The band spans the full width of the image and is attached along the TOP edge with a flat top; the bottom is a soft irregular fringe of hanging leaves. Nothing at the bottom of the frame.',
    size: '1536x1024',
    chroma: MAGENTA,
    maxDim: 1180,
  },
  {
    id: 'vines_hanging',
    group: 'canopy',
    subject:
      'Several long thin trailing vines with small leaves, hanging straight DOWN from the top edge of the frame like curtains, of varying lengths, some with tiny flowers. Attached along the flat TOP edge of the image, trailing down into empty space. Sparse and delicate, with clear gaps between the strands.',
    size: '1024x1536',
    chroma: MAGENTA,
    maxDim: 1000,
  },
  {
    id: 'cliff_column',
    group: 'tall',
    subject:
      'A single tall narrow weathered rock spire standing vertically, like a sea stack or a stone column, running the full height of the frame from the bottom edge to the top edge. Layered strata, chipped edges, a few small plants and moss clinging to ledges. Narrow, imposing, clearly taller than it is wide. Base at the bottom of frame.',
    size: '1024x1536',
    chroma: MAGENTA,
    maxDim: 1200,
  },

  // ------------------------------------------------------------- clouds
  {
    id: 'cloud_a',
    group: 'cloud',
    subject:
      'A single soft billowing cumulus cloud, wide and low, lit warm amber along its right and upper edges with cool violet in the shadowed underside. Soft rounded puffs, painterly, fully within frame.',
    size: '1536x1024',
    chroma: GREEN,
    maxDim: 900,
    tolerance: 150,
  },
  {
    id: 'cloud_b',
    group: 'cloud',
    subject:
      'A single long thin wispy stretched cloud bank, softly lit warm along the top edge, translucent and delicate. Fully within frame.',
    size: '1536x1024',
    chroma: GREEN,
    maxDim: 900,
    tolerance: 150,
  },

  // ------------------------------------------------------------- letters
  {
    id: 'block_stone',
    group: 'block',
    subject:
      'A single cube-shaped block of carved grey-blue stone seen straight-on from the front, like a collectible block in a platformer. Slightly rounded corners, chiselled bevelled edges catching warm light on the top and right, chipped weathered surface, moss in the lower crevices. The front face is EMPTY and flat with no symbol, no carving and no marking on it. Square proportions, centred in frame.',
    size: '1024x1024',
    chroma: MAGENTA,
    maxDim: 420,
  },
  {
    id: 'block_crystal',
    group: 'block',
    subject:
      'A single cube-shaped block of glowing translucent cyan crystal seen straight-on from the front, like a collectible block in a platformer. Faceted glassy surfaces, internal light refraction, bright warm rim-light along the top and right edges. The front face is EMPTY and flat with no symbol and no marking on it. Square proportions, centred in frame.',
    size: '1024x1024',
    chroma: MAGENTA,
    maxDim: 420,
  },
  {
    id: 'block_amber',
    group: 'block',
    subject:
      'A single cube-shaped block of warm golden amber resin seen straight-on from the front, like a collectible block in a platformer. Glossy translucent surface with darker inclusions, bevelled edges, bright highlight on the top and right. The front face is EMPTY and flat with no symbol and no marking on it. Square proportions, centred in frame.',
    size: '1024x1024',
    chroma: GREEN,
    maxDim: 420,
  },

  // ------------------------------------------------------------- character
  {
    id: 'hog_ball',
    group: 'hero',
    hero: true,
    subject:
      'A cute stylised cartoon hedgehog curled into a tight perfect ball for a rolling spin attack, seen from the side. Rounded ball silhouette covered in short swept-back indigo-purple quills with warm amber tips catching the light. Small round paws and a happy determined face just visible tucked at the front left. Heroic, appealing, game-mascot character design. Centred in frame.',
    size: '1024x1024',
    chroma: GREEN,
    maxDim: 420,
  },
  {
    id: 'hog_run',
    group: 'hero',
    hero: true,
    subject:
      'A cute rounded cartoon hedgehog character walking to the LEFT in strict profile side view. ANATOMY IS CRITICAL: it has EXACTLY FOUR legs in total — exactly two front legs and exactly two hind legs, and because this is a side view only two or three legs are visible at all. Do not draw five or six legs. Do not draw extra limbs. Short soft swept-back indigo-purple quills with warm amber tips cover its back, cream-coloured furry belly, small pointed brown snout with a dark button nose, one large friendly dark eye, one small rounded ear. It looks like a real hedgehog drawn as an appealing storybook animal.',
    size: '1024x1024',
    chroma: GREEN,
    maxDim: 460,
  },
      {
    id: 'hog_ball_blur',
    group: 'hero',
    hero: true,
    subject:
      'A spiky hedgehog curled into a ball and spinning fast, seen from the side. THE SILHOUETTE IS THE MOST IMPORTANT THING: sharp individual quill spikes clearly project outward and BREAK the circular outline all the way around, like a spiked wheel or a sawblade, so the shape is unmistakably a spiky hedgehog and never a smooth disc. Roughly 20 distinct pointed spikes around the rim, each catching bright warm amber light at its tip against a darker indigo body. Inside the rim, the quills blur into soft concentric bands to show rotation, but the spikes themselves stay crisp and hard-edged. A clean dark contour outlines the whole spiky shape. The centre is a soft pale cream blur. Bright, high contrast, bold and readable as a small game sprite.',
    size: '1024x1024',
    chroma: GREEN,
    maxDim: 420,
  },
  {
    id: 'hog_cheer',
    group: 'hero',
    hero: true,
    subject:
      'A cute stylised cartoon hedgehog game mascot celebrating: standing upright on its hind paws in profile side view, both front paws thrown joyfully up in the air, eye closed in a happy grin. Rounded body covered in short swept-back indigo-purple quills with warm amber tips, cream belly. Appealing platformer mascot design. Full body, centred in frame.',
    size: '1024x1024',
    chroma: GREEN,
    maxDim: 460,
  },
];

export const byId = (id) => ASSETS.find((a) => a.id === id);
export const groups = () => [...new Set(ASSETS.map((a) => a.group))];

/** Full prompt for one asset. */
export function promptFor(spec) {
  const parts = [STYLE, spec.subject];
  if (spec.hero) parts.push(HERO_ORIGINALITY);
  if (spec.chroma) parts.push(chromaClause(spec.chroma.name, spec.chroma.hex));
  else parts.push('The image fills the entire frame edge to edge with no border.');
  return parts.join(' ');
}
