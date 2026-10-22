-- A third kind of material besides RM and PM: consumables Production asks for by hand (gloves, masks, cleaning material ...).
ALTER TYPE "InventoryCategory" ADD VALUE IF NOT EXISTS 'OTHER';
