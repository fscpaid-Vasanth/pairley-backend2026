-- AlterTable
ALTER TABLE "businesses" ADD COLUMN     "lead_whatsapp_number" TEXT,
ADD COLUMN     "lead_whatsapp_verified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "notify_whatsapp" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "whatsapp_messages" (
    "id" TEXT NOT NULL,
    "business_id" TEXT,
    "customer_id" TEXT,
    "direction" TEXT NOT NULL,
    "template" TEXT,
    "to_number" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "related_lead_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "whatsapp_messages_business_id_created_at_idx" ON "whatsapp_messages"("business_id", "created_at");

