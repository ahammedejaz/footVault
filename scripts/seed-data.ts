/**
 * Foot Vault seed catalog — the single source of truth for `npm run seed`.
 *
 * Everything here is data an actual footwear retailer would hold: real brands
 * a shop in India stocks, real model names, real UK size runs, and prices in
 * the ranges those shoes actually sell for. Nothing is randomised, so a reseed
 * produces the same catalog and slugs stay stable across environments.
 *
 * Prices are integer paise. ₹8,995 is 899500.
 */

export const CURRENCY_MINOR_UNITS = 100;

/** ₹ helper so the tables below stay readable. rupees(8995) -> 899500 */
const rupees = (amount: number) => amount * CURRENCY_MINOR_UNITS;

// -----------------------------------------------------------------------------
// Categories — three top-level groups, each with its own children. Footwear
// *type* is a product column and a filter, not a category, so "sneakers" is not
// duplicated as a category under every group.
// -----------------------------------------------------------------------------

export type SeedCategory = {
  slug: string;
  name: string;
  parent?: string;
  description?: string;
  sortOrder: number;
  /** Tile art for the homepage grid. Replaced the moment the owner uploads one. */
  imageUrl?: string;
};

export const categories: SeedCategory[] = [
  {
    slug: "men",
    name: "Men",
    sortOrder: 1,
    description: "Sneakers, formal shoes, boots and sandals for men.",
    imageUrl: "/seed/category-men.svg",
  },
  {
    slug: "women",
    name: "Women",
    sortOrder: 2,
    description: "Sneakers, flats, sandals and sports shoes for women.",
    imageUrl: "/seed/category-women.svg",
  },
  {
    slug: "kids",
    name: "Kids",
    sortOrder: 3,
    description: "School shoes, sneakers and sandals built for growing feet.",
    imageUrl: "/seed/category-kids.svg",
  },

  { slug: "mens-sneakers", name: "Sneakers", parent: "men", sortOrder: 1 },
  { slug: "mens-formal", name: "Formal", parent: "men", sortOrder: 2 },
  { slug: "mens-sports", name: "Sports", parent: "men", sortOrder: 3 },
  {
    slug: "mens-sandals",
    name: "Sandals & Slides",
    parent: "men",
    sortOrder: 4,
  },
  { slug: "mens-boots", name: "Boots", parent: "men", sortOrder: 5 },

  { slug: "womens-sneakers", name: "Sneakers", parent: "women", sortOrder: 1 },
  {
    slug: "womens-flats",
    name: "Flats & Loafers",
    parent: "women",
    sortOrder: 2,
  },
  { slug: "womens-sports", name: "Sports", parent: "women", sortOrder: 3 },
  {
    slug: "womens-sandals",
    name: "Sandals & Slides",
    parent: "women",
    sortOrder: 4,
  },

  { slug: "kids-school", name: "School Shoes", parent: "kids", sortOrder: 1 },
  { slug: "kids-sneakers", name: "Sneakers", parent: "kids", sortOrder: 2 },
  { slug: "kids-sandals", name: "Sandals", parent: "kids", sortOrder: 3 },
];

// -----------------------------------------------------------------------------
// Brands
// -----------------------------------------------------------------------------

export type SeedBrand = { slug: string; name: string };

export const brands: SeedBrand[] = [
  { slug: "nike", name: "Nike" },
  { slug: "adidas", name: "adidas" },
  { slug: "puma", name: "Puma" },
  { slug: "new-balance", name: "New Balance" },
  { slug: "asics", name: "ASICS" },
  { slug: "skechers", name: "Skechers" },
  { slug: "campus", name: "Campus" },
  { slug: "woodland", name: "Woodland" },
  { slug: "bata", name: "Bata" },
  { slug: "crocs", name: "Crocs" },
  { slug: "red-chief", name: "Red Chief" },
  { slug: "metro", name: "Metro" },
];

// -----------------------------------------------------------------------------
// Size runs. UK sizing throughout — it is what an Indian retailer's shelf
// labels say, and the size guide converts to EU and US. Half sizes are text,
// which is why product_variants.size is text and not numeric.
// -----------------------------------------------------------------------------

export const SIZE_RUN_MEN = ["6", "7", "8", "9", "10", "11", "12"];
export const SIZE_RUN_WOMEN = ["3", "4", "5", "6", "7", "8"];
export const SIZE_RUN_KIDS = ["10C", "11C", "12C", "13C", "1", "2", "3"];

export type SeedColor = { name: string; hex: string };

export type SeedProduct = {
  slug: string;
  name: string;
  brand: string;
  category: string;
  gender: "men" | "women" | "unisex" | "kids";
  footwearType:
    "sneaker" | "formal" | "sandal" | "slide" | "boot" | "sports" | "flipflop";
  material: string;
  basePrice: number;
  salePrice?: number;
  featured?: boolean;
  description: string;
  colors: SeedColor[];
  /**
   * Overrides the gender's run. A clearance line down to its last size has a
   * run of one — which is a layout case worth having in the seed, because a
   * size strip of a single chip is where a grid built for seven falls over.
   */
  sizeRun?: string[];
  /** Sizes with no stock. Everything else in the run gets stock. */
  soldOut?: string[];
  /** Sizes down to their last pair or two, so "Only 2 left" has something real to say. */
  lowStock?: Record<string, number>;
};

/**
 * Thirty products. The mix is deliberate: enough sneakers to fill a grid, but
 * also the formal shoes, school shoes and monsoon sandals that are most of an
 * Indian footwear shop's actual turnover.
 */
export const products: SeedProduct[] = [
  // --- men's sneakers --------------------------------------------------------
  {
    slug: "nike-air-max-90-mens",
    name: "Air Max 90",
    brand: "nike",
    category: "mens-sneakers",
    gender: "men",
    footwearType: "sneaker",
    material: "Leather and mesh upper, rubber outsole",
    basePrice: rupees(12995),
    salePrice: rupees(9746),
    featured: true,
    description:
      "The 1990 silhouette, unchanged where it matters. Visible Air in the heel, waffle outsole, and the stitched overlays that let it take a monsoon without falling apart.",
    colors: [
      { name: "White / Grey", hex: "#e8e8e8" },
      { name: "Black / Volt", hex: "#1a1a1a" },
    ],
    soldOut: ["6", "12"],
    lowStock: { "9": 2, "10": 3 },
  },
  {
    slug: "adidas-samba-og-mens",
    name: "Samba OG",
    brand: "adidas",
    category: "mens-sneakers",
    gender: "unisex",
    footwearType: "sneaker",
    material: "Full-grain leather upper, gum rubber outsole",
    basePrice: rupees(9999),
    featured: true,
    description:
      "An indoor football shoe from 1950 that never needed redesigning. Low profile, gum sole, suede T-toe. Runs about half a size small — take the next size up if you are between.",
    colors: [
      { name: "Core Black", hex: "#141414" },
      { name: "Cloud White", hex: "#f4f1ec" },
    ],
    soldOut: ["6"],
    lowStock: { "8": 1 },
  },
  {
    slug: "new-balance-550-mens",
    name: "550",
    brand: "new-balance",
    category: "mens-sneakers",
    gender: "unisex",
    footwearType: "sneaker",
    material: "Leather upper, rubber cupsole",
    basePrice: rupees(11499),
    featured: true,
    description:
      "A 1989 basketball shoe brought back with the proportions intact. Stiff leather that creases in properly after a fortnight, and a cupsole that takes daily wear.",
    colors: [
      { name: "White / Green", hex: "#f2f2ee" },
      { name: "White / Navy", hex: "#eceff5" },
    ],
    lowStock: { "11": 2 },
  },
  {
    slug: "puma-suede-classic-mens",
    name: "Suede Classic XXI",
    brand: "puma",
    category: "mens-sneakers",
    gender: "unisex",
    footwearType: "sneaker",
    material: "Suede upper, rubber outsole",
    basePrice: rupees(6499),
    salePrice: rupees(4549),
    description:
      "Fifty years of the same shoe. Soft suede, formstrip, flat rubber sole. Brush it after the rain and it looks new.",
    colors: [
      { name: "Peacoat Navy", hex: "#232c3d" },
      { name: "Team Red", hex: "#7d1f27" },
    ],
    soldOut: ["12"],
  },
  {
    slug: "campus-north-plus-mens",
    name: "North Plus",
    brand: "campus",
    category: "mens-sneakers",
    gender: "men",
    footwearType: "sneaker",
    material: "Mesh upper, EVA midsole, TPR outsole",
    basePrice: rupees(1999),
    salePrice: rupees(1399),
    description:
      "The everyday trainer that does not pretend to be anything else. Light mesh, cushioned collar, and a price that survives being worn out in a year.",
    colors: [
      { name: "Grey", hex: "#8b8d92" },
      { name: "Black", hex: "#191919" },
      { name: "Navy", hex: "#22304a" },
    ],
    lowStock: { "7": 3 },
  },
  {
    slug: "skechers-go-walk-7-mens",
    name: "Go Walk 7",
    brand: "skechers",
    category: "mens-sneakers",
    gender: "men",
    footwearType: "sneaker",
    material: "Engineered knit upper, Air-Cooled Goga Mat insole",
    basePrice: rupees(6999),
    description:
      "Slip-on, machine washable, and light enough that you forget you are wearing them. The one people buy a second pair of.",
    colors: [
      { name: "Charcoal", hex: "#3d4046" },
      { name: "Taupe", hex: "#9a8d7d" },
    ],
    soldOut: ["6", "7"],
  },

  // --- men's sports ----------------------------------------------------------
  {
    slug: "asics-gel-nimbus-27-mens",
    name: "Gel-Nimbus 27",
    brand: "asics",
    category: "mens-sports",
    gender: "men",
    footwearType: "sports",
    material: "Engineered knit upper, FF Blast Plus Eco midsole",
    basePrice: rupees(16999),
    featured: true,
    description:
      "A max-cushion daily trainer for long, slow kilometres. Broad base, soft heel, and enough foam to take the sting out of concrete.",
    colors: [
      { name: "Black / Gold", hex: "#17181c" },
      { name: "Sky Blue", hex: "#8fb6d6" },
    ],
    lowStock: { "9": 2, "11": 1 },
  },
  {
    slug: "nike-pegasus-41-mens",
    name: "Pegasus 41",
    brand: "nike",
    category: "mens-sports",
    gender: "men",
    footwearType: "sports",
    material: "Mesh upper, ReactX foam midsole, Air Zoom units",
    basePrice: rupees(11895),
    salePrice: rupees(9516),
    description:
      "The workhorse. Two Air Zoom units under forefoot and heel, responsive enough for tempo work and forgiving enough for the easy days between.",
    colors: [
      { name: "Black / White", hex: "#141519" },
      { name: "Wolf Grey", hex: "#9aa0a8" },
    ],
    soldOut: ["12"],
  },
  {
    slug: "adidas-adizero-sl-mens",
    name: "Adizero SL",
    brand: "adidas",
    category: "mens-sports",
    gender: "unisex",
    footwearType: "sports",
    material: "Lightweight mesh upper, Lightstrike Pro midsole",
    basePrice: rupees(9999),
    description:
      "Light, snappy, and cheap enough to actually race in. The training shoe from the Adizero line without the carbon plate or the price.",
    colors: [{ name: "Core Black", hex: "#151515" }],
    lowStock: { "10": 2 },
  },
  {
    slug: "puma-velocity-nitro-3-mens",
    name: "Velocity Nitro 3",
    brand: "puma",
    category: "mens-sports",
    gender: "men",
    footwearType: "sports",
    material: "Mesh upper, Nitro foam midsole, PUMAGRIP outsole",
    basePrice: rupees(11999),
    salePrice: rupees(8399),
    description:
      "Nitrogen-injected foam and a genuinely good rubber outsole. Grips a wet road, which most trainers in this range do not.",
    colors: [
      { name: "Fire Orchid", hex: "#c33a2f" },
      { name: "Black", hex: "#181818" },
    ],
  },

  // --- men's formal ----------------------------------------------------------
  {
    slug: "red-chief-oxford-mens",
    name: "Leather Oxford",
    brand: "red-chief",
    category: "mens-formal",
    gender: "men",
    footwearType: "formal",
    material: "Full-grain buffalo leather, leather lining, TPR sole",
    basePrice: rupees(4295),
    featured: true,
    description:
      "A closed-lacing Oxford in full-grain leather that takes polish properly. Cushioned footbed, so it survives a full day of standing at a wedding.",
    colors: [
      { name: "Tan", hex: "#8a5a2b" },
      { name: "Black", hex: "#151515" },
    ],
    lowStock: { "8": 2 },
  },
  {
    slug: "bata-derby-mens",
    name: "Remo Derby",
    brand: "bata",
    category: "mens-formal",
    gender: "men",
    footwearType: "formal",
    material: "Synthetic leather upper, PVC sole",
    basePrice: rupees(1799),
    salePrice: rupees(1259),
    description:
      "The office shoe that does not need thinking about. Open lacing, slim last, and a sole you can resole once before replacing.",
    colors: [{ name: "Black", hex: "#131313" }],
    soldOut: ["11", "12"],
  },
  {
    slug: "metro-penny-loafer-mens",
    name: "Penny Loafer",
    brand: "metro",
    category: "mens-formal",
    gender: "men",
    footwearType: "formal",
    material: "Genuine leather upper, leather sole",
    basePrice: rupees(3999),
    description:
      "A slip-on with a proper leather sole and a saddle strap. Wears in around the instep after a week and then fits like nothing else.",
    colors: [
      { name: "Coffee Brown", hex: "#4a3223" },
      { name: "Black", hex: "#161616" },
    ],
    lowStock: { "9": 1 },
  },
  {
    slug: "woodland-brogue-mens",
    name: "Leather Brogue",
    brand: "woodland",
    category: "mens-formal",
    gender: "men",
    footwearType: "formal",
    material: "Nubuck leather, rubber outsole",
    basePrice: rupees(5495),
    salePrice: rupees(4396),
    description:
      "Broguing on a chunkier last with a real rubber outsole. A formal shoe that copes with a broken pavement.",
    colors: [{ name: "Khaki", hex: "#6f6244" }],
  },

  // --- men's boots -----------------------------------------------------------
  {
    slug: "woodland-camel-boot-mens",
    name: "Camel Leather Boot",
    brand: "woodland",
    category: "mens-boots",
    gender: "men",
    footwearType: "boot",
    material: "Nubuck leather upper, PU direct-injected sole",
    basePrice: rupees(6995),
    featured: true,
    description:
      "The boot the brand is known for. Nubuck upper, hand-stitched welt, and a sole bonded rather than glued so it does not part company in the rain.",
    colors: [
      { name: "Camel", hex: "#a97a48" },
      { name: "Olive", hex: "#4d5334" },
    ],
    soldOut: ["6"],
    lowStock: { "10": 2 },
  },
  {
    slug: "red-chief-chukka-mens",
    name: "Leather Chukka",
    brand: "red-chief",
    category: "mens-boots",
    gender: "men",
    footwearType: "boot",
    material: "Suede leather upper, crepe rubber sole",
    basePrice: rupees(4995),
    description:
      "Two eyelets, suede upper, crepe sole. Sits between a shoe and a boot, which makes it the one that gets worn most.",
    colors: [{ name: "Rust", hex: "#8c4a2f" }],
  },

  // --- men's sandals ---------------------------------------------------------
  {
    slug: "crocs-classic-clog-unisex",
    name: "Classic Clog",
    brand: "crocs",
    category: "mens-sandals",
    gender: "unisex",
    footwearType: "slide",
    material: "Croslite foam",
    basePrice: rupees(3995),
    salePrice: rupees(2796),
    featured: true,
    description:
      "Waterproof, washable, and the only thing worth owning in a monsoon. Pivoting heel strap for a closed fit, or back for a slide.",
    colors: [
      { name: "Navy", hex: "#1f3a5f" },
      { name: "Black", hex: "#1a1a1a" },
      { name: "Bone", hex: "#ded4c5" },
    ],
    lowStock: { "9": 3 },
  },
  {
    slug: "adidas-adilette-slide-unisex",
    name: "Adilette Comfort Slide",
    brand: "adidas",
    category: "mens-sandals",
    gender: "unisex",
    footwearType: "slide",
    material: "Synthetic bandage upper, Cloudfoam Plus footbed",
    basePrice: rupees(2999),
    salePrice: rupees(1949),
    description:
      "A pool slide with a contoured foam footbed. Dries in minutes and takes being left on a wet balcony.",
    colors: [
      { name: "Black", hex: "#171717" },
      { name: "Navy", hex: "#22334f" },
    ],
    soldOut: ["12"],
  },
  {
    slug: "bata-floater-sandal-mens",
    name: "Floater Sandal",
    brand: "bata",
    category: "mens-sandals",
    gender: "men",
    footwearType: "sandal",
    material: "Synthetic webbing upper, EVA footbed, rubber outsole",
    basePrice: rupees(1499),
    description:
      "Three adjustable straps, a grippy outsole, and a footbed that does not flatten by the second month. Built for the walk to the market and back.",
    colors: [
      { name: "Brown", hex: "#5b4230" },
      { name: "Black", hex: "#181818" },
    ],
  },
  {
    slug: "puma-flip-flop-unisex",
    name: "Epic Flip",
    brand: "puma",
    category: "mens-sandals",
    gender: "unisex",
    footwearType: "flipflop",
    material: "Synthetic thong strap, EVA footbed",
    basePrice: rupees(999),
    salePrice: rupees(699),
    description:
      "A flip-flop with a moulded arch instead of a flat slab of foam. Costs a little more and lasts three times as long.",
    colors: [{ name: "Black / White", hex: "#1c1c1c" }],
  },

  // --- women's sneakers ------------------------------------------------------
  {
    slug: "nike-court-vision-womens",
    name: "Court Vision Low",
    brand: "nike",
    category: "womens-sneakers",
    gender: "women",
    footwearType: "sneaker",
    material: "Leather upper, rubber cupsole",
    basePrice: rupees(5995),
    salePrice: rupees(4196),
    featured: true,
    description:
      "A clean court silhouette with a stitched leather upper. Goes with everything, which is the entire point of a white sneaker.",
    colors: [
      { name: "White / Pink", hex: "#f6f3f0" },
      { name: "White / Black", hex: "#f2f2f2" },
    ],
    lowStock: { "5": 2 },
  },
  {
    slug: "adidas-gazelle-womens",
    name: "Gazelle",
    brand: "adidas",
    category: "womens-sneakers",
    gender: "women",
    footwearType: "sneaker",
    material: "Suede upper, gum rubber outsole",
    basePrice: rupees(8999),
    featured: true,
    description:
      "Suede upper, slim last, gum sole. A training shoe from 1966 that has spent the last forty years being worn anywhere but the gym.",
    colors: [
      { name: "Collegiate Green", hex: "#2f5340" },
      { name: "Wonder Beige", hex: "#d8c8b4" },
    ],
    soldOut: ["3"],
  },
  {
    slug: "new-balance-327-womens",
    name: "327",
    brand: "new-balance",
    category: "womens-sneakers",
    gender: "women",
    footwearType: "sneaker",
    material: "Suede and nylon upper, EVA midsole",
    basePrice: rupees(9999),
    salePrice: rupees(6999),
    description:
      "An oversized N and a flared 70s outsole. Sits lower than it looks in photographs and runs true to size.",
    colors: [{ name: "Sea Salt", hex: "#e5ddd0" }],
    lowStock: { "6": 1 },
  },
  {
    slug: "skechers-summits-womens",
    name: "Summits",
    brand: "skechers",
    category: "womens-sneakers",
    gender: "women",
    footwearType: "sneaker",
    material: "Mesh upper, Air-Cooled Memory Foam insole",
    basePrice: rupees(4499),
    description:
      "Wide-fit mesh with a memory foam insole. The pair people buy when they are on their feet for eight hours.",
    colors: [
      { name: "Grey / Lavender", hex: "#a09fae" },
      { name: "All Black", hex: "#1b1b1b" },
    ],
  },

  // --- women's flats ---------------------------------------------------------
  {
    slug: "metro-ballerina-womens",
    name: "Leather Ballerina",
    brand: "metro",
    category: "womens-flats",
    gender: "women",
    footwearType: "formal",
    material: "Genuine leather upper, cushioned insole, TPR sole",
    basePrice: rupees(2799),
    salePrice: rupees(1959),
    description:
      "A soft leather flat with a padded insole and a sole that grips. Folds enough to live in a bag without creasing badly.",
    colors: [
      { name: "Black", hex: "#171717" },
      { name: "Tan", hex: "#a97852" },
    ],
    lowStock: { "4": 2 },
  },
  {
    slug: "bata-loafer-womens",
    name: "Slip-On Loafer",
    brand: "bata",
    category: "womens-flats",
    gender: "women",
    footwearType: "formal",
    material: "Synthetic leather upper, memory foam insole",
    basePrice: rupees(1999),
    description:
      "A round-toe loafer with a low block heel. Formal enough for an office, forgiving enough for a commute.",
    colors: [{ name: "Black", hex: "#151515" }],
    soldOut: ["8"],
  },

  // --- women's sports --------------------------------------------------------
  {
    slug: "asics-gel-cumulus-27-womens",
    name: "Gel-Cumulus 27",
    brand: "asics",
    category: "womens-sports",
    gender: "women",
    footwearType: "sports",
    material: "Jacquard mesh upper, FF Blast Plus midsole",
    basePrice: rupees(13999),
    salePrice: rupees(10499),
    description:
      "A neutral daily trainer that does not overreach. Softer than the Nimbus underfoot at the forefoot, and lighter by a good margin.",
    colors: [{ name: "Digital Aqua", hex: "#7fc0c4" }],
    lowStock: { "5": 2 },
  },
  {
    slug: "puma-softride-womens",
    name: "Softride Enzo",
    brand: "puma",
    category: "womens-sports",
    gender: "women",
    footwearType: "sports",
    material: "Knit upper, Softride foam midsole",
    basePrice: rupees(5999),
    salePrice: rupees(3599),
    description:
      "A gym and walking shoe with a rocker sole. Slips on, holds the heel, and is quiet on a treadmill.",
    colors: [
      { name: "Rose", hex: "#c88a8e" },
      { name: "Black", hex: "#1a1a1a" },
    ],
  },

  // --- women's sandals -------------------------------------------------------
  {
    slug: "crocs-brooklyn-slide-womens",
    name: "Brooklyn Low Wedge",
    brand: "crocs",
    category: "womens-sandals",
    gender: "women",
    footwearType: "slide",
    material: "Croslite foam, textured footbed",
    basePrice: rupees(4495),
    salePrice: rupees(3146),
    description:
      "A low wedge that is still entirely foam — waterproof, weightless, and washable under a tap.",
    colors: [
      { name: "Bone", hex: "#dfd6c8" },
      { name: "Black", hex: "#1c1c1c" },
    ],
    lowStock: { "6": 3 },
  },

  // --- kids ------------------------------------------------------------------
  {
    slug: "bata-school-shoe-kids",
    name: "Naughty Boy School Shoe",
    brand: "bata",
    category: "kids-school",
    gender: "kids",
    footwearType: "formal",
    material: "Synthetic leather upper, PVC sole, velcro strap",
    basePrice: rupees(1299),
    featured: true,
    description:
      "The black school shoe, with velcro instead of laces so it gets fastened properly. Scuffs wipe off with a damp cloth.",
    colors: [{ name: "Black", hex: "#141414" }],
    lowStock: { "13C": 2 },
  },
  {
    slug: "campus-kids-sneaker",
    name: "Junior Runner",
    brand: "campus",
    category: "kids-sneakers",
    gender: "kids",
    footwearType: "sneaker",
    material: "Mesh upper, EVA midsole, velcro closure",
    basePrice: rupees(1099),
    salePrice: rupees(769),
    description:
      "Light mesh, velcro, and a sole with real grip for a playground. Cheap enough to replace when the foot outgrows it in eight months.",
    colors: [
      { name: "Blue", hex: "#2f5aa8" },
      { name: "Pink", hex: "#d4718f" },
    ],
    soldOut: ["3"],
  },
  {
    slug: "crocs-kids-clog",
    name: "Classic Clog Kids",
    brand: "crocs",
    category: "kids-sandals",
    gender: "kids",
    footwearType: "slide",
    material: "Croslite foam",
    basePrice: rupees(2495),
    description:
      "The adult clog, scaled down, with the same heel strap. Survives a puddle, a beach and a wash cycle.",
    colors: [
      { name: "Bright Blue", hex: "#2a7fd4" },
      { name: "Bubblegum", hex: "#e08aa8" },
    ],
    lowStock: { "12C": 1 },
  },

  // ---------------------------------------------------------------------------
  // Three products that exist because the layout has to survive them.
  //
  // A catalog of well-behaved products is a catalog that has never been tested.
  // These are the cases a real shop produces within a month of opening, and
  // each one broke something the first time it was rendered.
  // ---------------------------------------------------------------------------
  {
    // Sold out in every size. The size strip is entirely struck through, the
    // card carries the SOLD OUT flag, and the product page has to say so
    // without hiding the run — which is the whole promise of the size strip.
    slug: "adidas-gazelle-indoor-womens",
    name: "Gazelle Indoor",
    brand: "adidas",
    category: "womens-sneakers",
    gender: "women",
    footwearType: "sneaker",
    material: "Suede upper, gum rubber outsole",
    basePrice: rupees(10999),
    description:
      "The indoor court shape, in suede, with the gum sole that marks nothing. This colourway sold through in a fortnight and is not coming back — the run below is the full run.",
    colors: [{ name: "Collegiate Green", hex: "#2f5340" }],
    soldOut: ["3", "4", "5", "6", "7", "8"],
  },
  {
    // One size, one colourway, no sale price. Three "only one of these" cases
    // in a single product, because they tend to arrive together on a clearance
    // line and the layout has to hold at its narrowest.
    slug: "woodland-nubuck-trek-mens",
    name: "Nubuck Trek Boot",
    brand: "woodland",
    category: "mens-boots",
    gender: "men",
    footwearType: "boot",
    material: "Nubuck leather upper, stitched-down rubber outsole",
    basePrice: rupees(6495),
    description:
      "End of the line. One pair left, in one size, at the price it always was.",
    colors: [{ name: "Khaki", hex: "#6f6244" }],
    sizeRun: ["9"],
    lowStock: { "9": 1 },
  },
  {
    // Sixty-six characters. Long names are what a distributor's spreadsheet
    // produces, and they land in card titles, breadcrumbs, the header of the
    // product page, and the browser tab.
    slug: "asics-gel-kayano-31-wide-womens",
    name: "Gel-Kayano 31 Wide Fit Stability Running Trainer for Overpronation",
    brand: "asics",
    category: "womens-sports",
    gender: "women",
    footwearType: "sports",
    material: "Engineered knit upper, FF Blast Plus Eco midsole",
    basePrice: rupees(15999),
    salePrice: rupees(12799),
    description:
      "The stability trainer, in the wide fit, for a foot that rolls in. Guidance comes from the sole geometry rather than a hard post, so it does not fight a neutral stride on the days you have one.",
    colors: [
      { name: "Sea Salt", hex: "#e5ddd0" },
      { name: "Peacoat Navy", hex: "#232c3d" },
    ],
    soldOut: ["8"],
    lowStock: { "7": 2 },
  },
];

/**
 * Words a customer might search that the copy does not use.
 *
 * "Running" appears in none of the running-shoe descriptions — they say
 * "trainer", "tempo", "race" — and "chappal" appears in none of the sandal
 * ones. Both are what people actually type.
 */
export const SEARCH_KEYWORDS: Record<SeedProduct["footwearType"], string[]> = {
  sports: [
    "running",
    "runner",
    "trainer",
    "training",
    "gym",
    "jogging",
    "workout",
    "marathon",
  ],
  sneaker: ["casual", "trainers", "lifestyle", "everyday", "street"],
  formal: ["office", "dress", "wedding", "oxford", "derby", "business"],
  boot: ["ankle", "hiking", "outdoor", "trekking", "winter"],
  sandal: ["chappal", "monsoon", "summer", "open", "strappy"],
  slide: ["chappal", "monsoon", "pool", "beach", "slipper", "sliders"],
  flipflop: ["chappal", "thong", "beach", "monsoon", "slipper"],
};

/**
 * The homepage hero art.
 *
 * Two crops of the same scene, not one image letterboxed twice: a 16:9 hero
 * cropped to a 390px phone loses the shoe entirely, and a phone-shaped hero
 * stretched across a desktop loses the point. The banners table has carried
 * `image_url` and `mobile_image_url` since Phase 1 for exactly this.
 */
export const heroBanner = {
  placement: "home_hero",
  imageUrl: "/seed/hero-desktop.svg",
  mobileImageUrl: "/seed/hero-mobile.svg",
  headline: "Every size we hold, shown on every shoe",
  subtext: "Sneakers, formal shoes, boots and sandals for men, women and kids.",
  ctaLabel: "Shop all footwear",
  ctaHref: "/shop",
  altText:
    "A running shoe and its outsole against the Foot Vault tread pattern",
};

// -----------------------------------------------------------------------------
// Collections — the curated rails the owner reorders from /admin/appearance.
// -----------------------------------------------------------------------------

export const collections = [
  {
    slug: "new-arrivals",
    name: "New arrivals",
    description: "Just landed on the shelf.",
    sortOrder: 1,
    products: [
      "adidas-samba-og-mens",
      "new-balance-550-mens",
      "asics-gel-nimbus-27-mens",
      "adidas-gazelle-womens",
      "nike-air-max-90-mens",
      "woodland-camel-boot-mens",
    ],
  },
  {
    slug: "monsoon-ready",
    name: "Monsoon ready",
    description: "Waterproof, washable, and happy in standing water.",
    sortOrder: 2,
    products: [
      "crocs-classic-clog-unisex",
      "adidas-adilette-slide-unisex",
      "bata-floater-sandal-mens",
      "crocs-brooklyn-slide-womens",
      "crocs-kids-clog",
      "puma-flip-flop-unisex",
    ],
  },
  {
    slug: "under-2000",
    name: "Under ₹2,000",
    description: "Everything on this rail is under two thousand rupees.",
    sortOrder: 3,
    products: [
      "campus-north-plus-mens",
      "bata-derby-mens",
      "bata-floater-sandal-mens",
      "bata-school-shoe-kids",
      "campus-kids-sneaker",
      "puma-flip-flop-unisex",
      "bata-loafer-womens",
    ],
  },
];

// -----------------------------------------------------------------------------
// CMS pages. Real policy copy — the owner edits these from /admin/pages, but
// shipping a store with an empty returns policy is not an option.
// -----------------------------------------------------------------------------

export const pages = [
  {
    slug: "about",
    title: "About Foot Vault",
    metaTitle: "About",
    metaDescription:
      "Foot Vault is a footwear shop in Proddatur, in the YSR Kadapa district of Andhra Pradesh. The same shelves that serve the counter serve this website.",
    body: `Foot Vault is a footwear shop in Proddatur, in the YSR Kadapa district of Andhra Pradesh. There is a real shop with real shelves, near the RTC bus stand, and this website sells from the same stock.

That last part is the whole point of it, so it is worth saying plainly rather than leaving it to be assumed. Nothing here is drop-shipped and nothing is ordered in after you buy it. When your order arrives with us, somebody walks to a shelf, takes the box down, opens it, checks the pair inside and packs it.

**The size counts are real.** If a product page says one pair is left in your size, there is one pair on the shelf. A size shown as sold out is genuinely gone — we do not hide sizes to make a run look fuller than it is, and we would rather show you an honest gap than a full grid you cannot buy from.

**What we stock.** Sneakers, formal shoes, boots, sports shoes and sandals, for men, women and kids. The brands are the ones people come in and ask for by name — at the moment Nike, adidas, Puma, ASICS, New Balance, Skechers, Campus, Bata, Metro, Red Chief, Woodland and Crocs. It is a narrower range than a marketplace carries, deliberately: everything on the site is something we would put in front of somebody across the counter.

**What we do not do, said here rather than in the small print.** We do not offer refunds, and we cannot exchange for a different size. If a pair arrives damaged we replace it, and there is a short window to tell us. The returns page explains it properly, and it is worth two minutes before you buy rather than after — a policy you only discover afterwards is a policy designed to catch you out, and this one is not.

**If something is wrong.** One message sorts it out. Ring the shop or send a WhatsApp; the number and our opening hours are on the contact page. You will get somebody who can walk to the shelf and look.

Come and see us if you are nearby. Trying a pair on is still the best way to buy shoes, and we would rather you did that than guess.`,
  },
  {
    slug: "contact",
    title: "Contact us",
    metaDescription:
      "Phone, WhatsApp, email and the address of the Foot Vault shop in Proddatur, YSR Kadapa district, Andhra Pradesh, with our opening hours.",
    body: `The quickest way to reach us is WhatsApp, on {{contact_whatsapp}}. We answer during shop hours, usually within the hour. If you would rather talk, ring the shop on {{contact_phone}} — it is the same people at the same counter.

Prefer email? Write to {{contact_email}}. Replying to any email we have sent you about an order lands in the same inbox, so you can simply hit reply.

For an order that already exists, send the order number — it looks like FV-2026-00147 — and we can pull it up straight away.

**If a parcel has arrived damaged, ring or send a WhatsApp message rather than emailing.** That claim closes {{return_window}} after delivery, and an email may not be read in time. The returns page lists what to send us.

**Where we are.** {{contact_address}}. That is Proddatur, in the YSR Kadapa district of Andhra Pradesh.

**When we are open.** {{business_hours}}.

You are welcome to come in and try a pair on. There is nothing to book and no appointment to make: come to the counter and ask. Trying shoes on is still the best way to buy them, and somebody who can walk to the shelf will be standing in front of you.`,
  },
  {
    slug: "shipping",
    title: "Shipping",
    metaDescription:
      "What delivery costs, when your order leaves our shop in Proddatur, and how Pay on Delivery works. Free delivery over {{free_shipping_threshold}}.",
    body: `We ship across India from our shop in Proddatur, Andhra Pradesh.

Orders placed before {{dispatch_cutoff}} are handed to the courier the same day. Anything later goes with the next day's collection.

How long the journey then takes depends on where it is going, and we would rather show you the real figure than an average. Enter your pin code on any product page and we will give you the dates for your own address, taken from the courier that will actually be carrying the parcel. Checkout shows them again before you pay.

**Paying online** — delivery is free on orders of {{free_shipping_threshold}} or more. Below that you pay what the courier charges to reach your pin code. The exact figure appears as soon as you enter your pin code, never added at the last step.

**Pay on Delivery** — you pay {{delivery_advance}} online when you place the order, and the rest in cash to the courier when it arrives. Your order is not placed until that first payment goes through.

The amount you pay now covers delivery, and it is taken off what the courier collects — so you pay the same either way. Checkout shows all three figures before you pay: what you pay now, what the courier will collect, and the total.

Pay on Delivery is offered on orders of {{cod_minimum_order_value}} and above. Below that, paying online is the only option, because the delivery charge would be most of the order.

Not every courier will collect cash at every pin code. If yours is one they will not, the option is not offered and you can pay online instead — the order still comes to the same address. A very small number of pin codes have no courier service from us at all, and checkout will say so before you pay rather than take an order we cannot deliver.`,
  },
  {
    slug: "returns",
    title: "Returns and damage",
    metaDescription:
      "Replacement only: no refunds, no size exchanges, no online returns. Tell us within {{return_window}} if your parcel arrives damaged and we will replace it.",
    body: `Please read this before you buy. Our policy is narrower than most online shops and we would rather you know that now than discover it later.

**We do not offer refunds.** Not on change of mind, not on size, not on colour. Once an order is placed it is yours.

**We do not take returns online.** There is no returns button in your account and no pickup will be arranged. Everything below happens by contacting the store directly.

**If a pair arrives damaged, we will replace it.** That is the one thing we cover, and it comes with a hard deadline:

- Contact us **within {{return_window}} of the parcel being delivered**. After that we cannot help, because we can no longer tell damage in transit from damage in use.
- Call or WhatsApp the store on the number on our contact page, or email {{contact_email}}. With only {{return_window}}, call or WhatsApp first rather than waiting on an email reply.
- Keep the box, the packaging and the courier label. Send us photographs of the damage and of the packaging it arrived in \u2014 the courier will not accept a claim without them.
- Do not wear the pair. A sole that has been outside cannot be assessed or replaced.

If we agree the pair was damaged in transit, we send a replacement of the same item in the same size, subject to us holding it. If we do not hold it, we will agree something with you directly.

**Sizes.** We cannot exchange for a different size, so please use the size guide on every product page before ordering, and ask us if you are unsure. We would much rather answer a question than turn down a request afterwards.

**Pay on Delivery.** The amount you pay online when you place the order covers delivery both ways. If you cancel before we have handed the parcel to the courier, it comes back to you in full. Once it is on the road it is not refundable, because it pays the courier to carry the parcel to you and again to carry it back if it is refused.

**If we get it wrong** \u2014 the wrong shoe, the wrong size, or damage that happened before it left us \u2014 you get everything back, with nothing deducted. That is not the same as a change of mind, and we do not treat it as one.

Nothing on this page affects your statutory rights under Indian consumer law.`,
  },
  {
    slug: "size-guide",
    title: "Size guide",
    metaDescription:
      "UK, EU and US shoe size conversions, and how to measure your foot at home.",
    body: `Every size on this site is UK. The conversions below are the ones we use.

UK 6 = EU 40 = US 7. UK 7 = EU 41 = US 8. UK 8 = EU 42 = US 9. UK 9 = EU 43 = US 10. UK 10 = EU 44 = US 11. UK 11 = EU 45.5 = US 12. UK 12 = EU 47 = US 13.

To measure at home: stand on a sheet of paper with your heel against a wall, mark the tip of your longest toe, and measure the distance in centimetres. Do it in the evening, when your feet are at their largest, and measure both \u2014 most people have one foot slightly bigger and you should buy for that one.

Where a shoe runs small or large we say so on its product page.`,
  },
  {
    slug: "privacy",
    title: "Privacy policy",
    metaTitle: "Privacy policy",
    metaDescription:
      "What Foot Vault collects when you order, why we hold it, which companies see it, how long we keep it, and how to have it deleted.",
    body: `This page says what we collect when you buy from Foot Vault, why we hold it, who else sees it, and what you can ask us to do with it. It is written to be read rather than filed.

**What we collect.**

- Your name, delivery address, phone number and email address. A parcel cannot be delivered without them.
- What you ordered, what you paid, and how you paid.
- Your account, if you make one — the same details, plus your order history.
- Your bag, held against a token in your browser until you sign in, at which point it moves to your account.
- The ordinary technical record every website keeps: your IP address, your browser, and which pages you asked for.

We never see your card details. They pass from your browser to our payment processor and do not reach us.

**Why we hold it.** To pack and deliver your order, to contact you about it, to take and return payment, to show you your order history when you sign in, to answer you when you get in touch, and to keep the sales records the law requires us to keep.

**Who else sees it.** Running a shop that delivers means other companies handle parts of it. These are all of them, and what each one gets.

- **Razorpay** takes the payment. They receive the amount, the order reference, and whatever you type into their payment form.
- **Shiprocket** arranges the delivery. They receive your name, full address, phone number and what is in the parcel, and they pass those to whichever courier collects it.
- **Resend** sends our email. They receive your email address and the contents of each message we send you.
- **Supabase** hosts our database and runs the sign-in. Your account, orders and addresses are stored there.
- **Google** does two things. If you choose "Continue with Google", Google confirms who you are and gives us your name and email address — we never receive your Google password. Separately, the map on our contact page is served by Google, so opening that page tells Google your IP address and your browser whether or not you touch the map.
- **Vercel** serves this website. Every request passes through them and is logged, which includes your IP address.

We do not sell your data, and we do not pass it to anyone for advertising.

**How long we keep it.** Order records are kept for as long as tax and company law requires us to keep sales records — we cannot delete an invoice on request, and neither can any shop. Everything else is kept while your account exists. Server logs are short-lived and are not used to build a profile of you.

**Cookies.** This site sets what it needs and nothing more: one to keep you signed in, and one to remember your bag before you sign in. We run no advertising cookie, no analytics and no tracking script of our own. The one part of the site loaded from another company is the Google map on our contact page, and Google may set its own cookies when that page opens; those are governed by Google's policy rather than ours. If anything else changes, this page changes with it and says so.

**What you can ask for.** You can ask us for a copy of what we hold about you, ask us to correct anything that is wrong, ask us to delete your account, or withdraw a consent you have given. You can also tell us who may act for you if you are unable to.

**Deleting your account.** Write to {{contact_email}} from the address on the account, and we will confirm once it is done. We will remove it within {{deletion_window}} of the request. Orders you have already placed stay in the sales records, without the account attached to them.

**If you are unhappy with how we have handled this.** Write to {{contact_email}} and mark it for the grievance officer, or ring the shop on {{contact_phone}}. If we have not put it right, you may complain to the Data Protection Board of India.

**Changes to this page.** When we change it we change the page rather than emailing everyone; the date it was last updated is at the bottom.`,
  },
  {
    slug: "terms",
    title: "Terms of sale",
    metaTitle: "Terms of sale",
    metaDescription:
      "How an order is accepted, what happens if a price or a stock count is wrong, when you can cancel, and the law these terms are governed by.",
    body: `These terms apply when you buy from Foot Vault. The shipping and returns pages are part of the same agreement, so read those too — between them they cover most of what people actually write in to ask.

**Who you are buying from.** {{registered_name}}, trading as Foot Vault. GSTIN {{gstin}}. Registered place of business: {{registered_address}}.

**Prices.** Prices are in Indian rupees and include all taxes. The price shown in your bag is the price you pay. Delivery, where it is charged, is shown separately before you pay and is never added at the last step.

**When an order becomes an order.** Placing an order is an offer to buy. It becomes a contract when we confirm it, not when you press the button and not when the payment is taken. Until then we may decline it — the usual reasons are stock, an address no courier will serve, or a payment we cannot verify — and anything you have paid comes straight back.

**Stock.** The counts on this site are live. Where a product page says two are left in your size, that is the number on the shelf. If something still sells out between your order and our packing it, we will tell you which item and return that line in full.

**Mistakes in a price or a description.** We check both, and occasionally one is still wrong. Where a price or a description is obviously mistaken we are not obliged to sell at it. If we notice after you have paid, we will tell you, and you can either accept the corrected price or have your money back in full.

**Cancelling before dispatch.** Write or ring before we have handed the parcel to the courier and we will cancel the order and return what you paid in full, including any delivery you paid for. Once it is on the road it cannot be cancelled.

**Delivery.** We dispatch from our shop and the courier carries it from there. The dates you are shown come from that courier and are their estimate, not a guarantee — a strike, a flood or a closed road is not something we can promise around. What we do promise is that we hand it over on time, and that we tell you when we have.

**Replacement, not refund.** We do not offer refunds — not on change of mind, not on size, not on colour. If a pair arrives damaged we will replace it, provided you tell us within {{return_window}} of delivery. We cannot exchange for a different size. The returns page sets out the conditions in full, and they are conditions rather than formalities.

**When the fault is ours.** The wrong shoe, the wrong size, an item we cannot supply, or damage that happened before it left us: you get everything back with nothing deducted. That is not a change of mind and we do not treat it as one, so the rule above does not apply to it.

**Your statutory rights.** Nothing on this page or anywhere else on this site affects your rights under the Consumer Protection Act, 2019 or any other law of India.

**Law.** These terms are governed by the laws of India.`,
  },
];

// -----------------------------------------------------------------------------
// Store settings. From Phase 7 these are edited at /admin/settings; the
// storefront reads them rather than the hard-coded values in site-config.ts.
// -----------------------------------------------------------------------------

export const siteSettings: Array<{
  key: string;
  value: unknown;
  description: string;
}> = [
  {
    key: "store_name",
    value: "Foot Vault",
    description: "Shop name, used in the header, metadata and invoices.",
  },
  {
    key: "store_tagline",
    value: "Every step counts",
    description: "Wordmark tagline.",
  },
  {
    key: "announcement",
    value: {
      text: "Damage on arrival? Tell us within {{return_window}} · Free delivery over {{free_shipping_threshold}}",
      href: "/page/returns",
      is_active: true,
    },
    description: "The thin strip above the header.",
  },
  {
    key: "contact",
    value: {
      email: "hello@footvault.in",
      phone: "+91 80 4718 2200",
      whatsapp: "+91 98450 22001",
      address: "42 Commercial Street, Shivaji Nagar, Bengaluru 560001",
    },
    description: "Shown in the footer and on the contact page.",
  },
  {
    key: "business_hours",
    value: {
      weekday: "10:30 – 20:30",
      saturday: "10:30 – 21:00",
      sunday: "11:00 – 19:00",
    },
    description: "Opening hours, shown on the contact page.",
  },
  {
    key: "social",
    value: {
      instagram: "https://instagram.com/footvault",
      facebook: "https://facebook.com/footvault",
    },
    description: "Social links in the footer.",
  },
  // There is deliberately no `shipping` entry here. The seed used to carry one
  // and it was a fossil: the ₹2,499 threshold from two phases before, plus the
  // exact keys (`fallback_fee_paise`, the three `cod_advance_*`) that
  // `20260809110100` deletes — so reseeding a migrated database un-migrated its
  // settings, and docs/staging.md grew a "now repair the row" step. The row is
  // created by `20260809140000_shipping_settings_row_exists.sql` with the
  // owner's confirmed numbers and belongs to the migrations alone. If you are
  // about to add it back, that migration's header is the argument against.
  {
    key: "return_window_days",
    value: 1,
    description:
      "How long after delivery damage in transit may be reported. This row is that window \u2014 the returns page, the announcement strip and the terms all resolve it through {{return_window}}, so changing the number here changes every sentence at once. There is no returns window for a change of mind and no refunds; damage in transit is replaced. Stored in days because the column is days; a value of one is rendered to customers in hours.",
  },
  {
    key: "payment_methods",
    value: { cod: true, online: false },
    description:
      "Both methods run through Razorpay: prepaid settles in full, Pay on Delivery takes the advance. Read by nothing today — the checkout gates on isAvailable() and the cod_enabled flag in `shipping`.",
  },
];

// -----------------------------------------------------------------------------
// The homepage, as rows. Changing the order of this array changes the order of
// the live homepage — which is exactly what the owner will do from the admin.
// -----------------------------------------------------------------------------

export const homepageSections = [
  {
    sectionType: "hero" as const,
    title: "Every size we hold, shown on every shoe",
    subtitle:
      "Sneakers, formal shoes, boots and sandals for men, women and kids.",
    payload: {
      eyebrow: "Foot Vault",
      cta_label: "Shop all footwear",
      cta_href: "/shop",
      secondary_cta_label: "New arrivals",
      secondary_cta_href: "/collection/new-arrivals",
    },
    sortOrder: 1,
  },
  {
    sectionType: "category_grid" as const,
    title: "Shop by department",
    payload: { category_slugs: ["men", "women", "kids"] },
    sortOrder: 2,
  },
  {
    sectionType: "product_rail" as const,
    title: "New arrivals",
    subtitle: "Just landed on the shelf.",
    payload: {
      collection_slug: "new-arrivals",
      cta_href: "/collection/new-arrivals",
    },
    sortOrder: 3,
  },
  {
    sectionType: "promo_strip" as const,
    title: "What you can count on",
    payload: {
      items: [
        {
          label: "Damaged in transit? Replaced",
          detail: "Tell us within {{return_window}} of delivery.",
        },
        {
          label: "Free delivery over {{free_shipping_threshold}}",
          detail: "The courier's own rate below that.",
        },
        {
          label: "Pay on Delivery",
          detail: "Delivery charge now, the rest in cash at the door.",
        },
        {
          label: "Live stock counts",
          detail: "If it says two left, there are two.",
        },
      ],
    },
    sortOrder: 4,
  },
  {
    sectionType: "product_rail" as const,
    title: "Monsoon ready",
    subtitle: "Waterproof, washable, and happy in standing water.",
    payload: {
      collection_slug: "monsoon-ready",
      cta_href: "/collection/monsoon-ready",
    },
    sortOrder: 5,
  },
  {
    sectionType: "banner" as const,
    title: "Under ₹2,000",
    subtitle: "School shoes, everyday trainers and sandals that do the job.",
    payload: { cta_label: "Shop the rail", cta_href: "/collection/under-2000" },
    sortOrder: 6,
  },
  /**
   * A `rich_text` section, seeded so the perceptual gates actually see it.
   *
   * `rich_text` had been in the `section_type` enum since the first migration
   * with no renderer, and got one in Phase 10 Batch C. Leaving it out of the seed
   * would mean `audit:a11y`, `audit:overflow` and the six-width tap-target pass
   * never render it — the new section would be checked only by the one gate
   * written for it, which is how "built but unmeasured" happens.
   *
   * It carries a token, a `**bold**` span and a bullet list, because those are
   * the three things this renderer does and an example that exercises none of
   * them proves the section draws but not that it works.
   */
  {
    sectionType: "rich_text" as const,
    title: "How sizing works here",
    subtitle: null,
    payload: {
      body:
        "Every size on a product page is a size we physically hold. If it is " +
        "listed, it is on the shelf — we do not show a size run and then " +
        "cancel your order.\n\n" +
        "- Sizes are UK, the way Indian shops quote them\n" +
        "- **Delivery is free over {{free_shipping_threshold}}**\n" +
        "- Damaged on arrival? Tell us within {{return_window}}",
    },
    sortOrder: 7,
  },
];
