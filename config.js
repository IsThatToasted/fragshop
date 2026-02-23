// config.js
window.SHOP_CONFIG = {
  // Inventory "database" repo (READ ONLY)
  inventoryOwner: "IsThatToasted",
  inventoryRepo: "fragtrack",

  // Required labels in inventory repo for an item to show in the shop
  inventoryListLabel: "list:inventory",
  inStockLabel: "In Stock",

  // Shop repo (THIS repo) where reservation issues are created
  shopOwner: "IsThatToasted",
  shopRepo: "fragshop", // <-- change if different

  // Label to apply to reservation issues in this shop repo
  reservationLabel: "reservation",

  // Display
  housePreviewCount: 4,
  cacheMinutes: 10,

  // Optional: include extra instructions in the prefilled issue body
  reservationInstructions:
    "Fill in your contact info below. The seller will confirm availability and reach out to finalize.",
};