export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      addresses: {
        Row: {
          city: string
          country: string
          created_at: string
          id: string
          is_default: boolean
          label: string | null
          line1: string
          line2: string | null
          phone: string
          postal_code: string
          recipient_name: string
          state: string
          updated_at: string
          user_id: string
        }
        Insert: {
          city: string
          country?: string
          created_at?: string
          id?: string
          is_default?: boolean
          label?: string | null
          line1: string
          line2?: string | null
          phone: string
          postal_code: string
          recipient_name: string
          state: string
          updated_at?: string
          user_id: string
        }
        Update: {
          city?: string
          country?: string
          created_at?: string
          id?: string
          is_default?: boolean
          label?: string | null
          line1?: string
          line2?: string | null
          phone?: string
          postal_code?: string
          recipient_name?: string
          state?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "addresses_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      banners: {
        Row: {
          created_at: string
          cta_href: string | null
          cta_label: string | null
          ends_at: string | null
          headline: string | null
          id: string
          image_url: string | null
          is_active: boolean
          mobile_image_url: string | null
          placement: string
          sort_order: number
          starts_at: string | null
          subtext: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          cta_href?: string | null
          cta_label?: string | null
          ends_at?: string | null
          headline?: string | null
          id?: string
          image_url?: string | null
          is_active?: boolean
          mobile_image_url?: string | null
          placement?: string
          sort_order?: number
          starts_at?: string | null
          subtext?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          cta_href?: string | null
          cta_label?: string | null
          ends_at?: string | null
          headline?: string | null
          id?: string
          image_url?: string | null
          is_active?: boolean
          mobile_image_url?: string | null
          placement?: string
          sort_order?: number
          starts_at?: string | null
          subtext?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      brands: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          logo_url: string | null
          name: string
          slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          logo_url?: string | null
          name: string
          slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          logo_url?: string | null
          name?: string
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      cart_items: {
        Row: {
          cart_id: string
          created_at: string
          id: string
          quantity: number
          unit_price_seen: number | null
          updated_at: string
          variant_id: string
        }
        Insert: {
          cart_id: string
          created_at?: string
          id?: string
          quantity?: number
          unit_price_seen?: number | null
          updated_at?: string
          variant_id: string
        }
        Update: {
          cart_id?: string
          created_at?: string
          id?: string
          quantity?: number
          unit_price_seen?: number | null
          updated_at?: string
          variant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cart_items_cart_id_fkey"
            columns: ["cart_id"]
            isOneToOne: false
            referencedRelation: "carts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cart_items_variant_id_fkey"
            columns: ["variant_id"]
            isOneToOne: false
            referencedRelation: "product_variants"
            referencedColumns: ["id"]
          },
        ]
      }
      carts: {
        Row: {
          created_at: string
          guest_token: string | null
          id: string
          status: Database["public"]["Enums"]["cart_status"]
          updated_at: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          guest_token?: string | null
          id?: string
          status?: Database["public"]["Enums"]["cart_status"]
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          guest_token?: string | null
          id?: string
          status?: Database["public"]["Enums"]["cart_status"]
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "carts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      categories: {
        Row: {
          created_at: string
          description: string | null
          id: string
          image_url: string | null
          is_active: boolean
          name: string
          parent_id: string | null
          slug: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          image_url?: string | null
          is_active?: boolean
          name: string
          parent_id?: string | null
          slug: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          image_url?: string | null
          is_active?: boolean
          name?: string
          parent_id?: string | null
          slug?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "categories_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
        ]
      }
      collection_products: {
        Row: {
          collection_id: string
          created_at: string
          id: string
          product_id: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          collection_id: string
          created_at?: string
          id?: string
          product_id: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          collection_id?: string
          created_at?: string
          id?: string
          product_id?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "collection_products_collection_id_fkey"
            columns: ["collection_id"]
            isOneToOne: false
            referencedRelation: "collections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "collection_products_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      collections: {
        Row: {
          created_at: string
          description: string | null
          id: string
          image_url: string | null
          is_active: boolean
          name: string
          slug: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          image_url?: string | null
          is_active?: boolean
          name: string
          slug: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          image_url?: string | null
          is_active?: boolean
          name?: string
          slug?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      coupons: {
        Row: {
          code: string
          created_at: string
          expires_at: string | null
          id: string
          is_active: boolean
          max_discount: number | null
          min_order_value: number
          starts_at: string | null
          type: Database["public"]["Enums"]["coupon_type"]
          updated_at: string
          usage_limit: number | null
          used_count: number
          value: number
        }
        Insert: {
          code: string
          created_at?: string
          expires_at?: string | null
          id?: string
          is_active?: boolean
          max_discount?: number | null
          min_order_value?: number
          starts_at?: string | null
          type: Database["public"]["Enums"]["coupon_type"]
          updated_at?: string
          usage_limit?: number | null
          used_count?: number
          value: number
        }
        Update: {
          code?: string
          created_at?: string
          expires_at?: string | null
          id?: string
          is_active?: boolean
          max_discount?: number | null
          min_order_value?: number
          starts_at?: string | null
          type?: Database["public"]["Enums"]["coupon_type"]
          updated_at?: string
          usage_limit?: number | null
          used_count?: number
          value?: number
        }
        Relationships: []
      }
      homepage_sections: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          payload: Json
          section_type: Database["public"]["Enums"]["section_type"]
          sort_order: number
          subtitle: string | null
          title: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          payload?: Json
          section_type: Database["public"]["Enums"]["section_type"]
          sort_order?: number
          subtitle?: string | null
          title?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          payload?: Json
          section_type?: Database["public"]["Enums"]["section_type"]
          sort_order?: number
          subtitle?: string | null
          title?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      integration_tokens: {
        Row: {
          expires_at: string
          provider: string
          refreshed_at: string
          token: string
        }
        Insert: {
          expires_at: string
          provider: string
          refreshed_at?: string
          token: string
        }
        Update: {
          expires_at?: string
          provider?: string
          refreshed_at?: string
          token?: string
        }
        Relationships: []
      }
      inventory_movements: {
        Row: {
          actor: string | null
          balance_after: number
          created_at: string
          delta: number
          id: string
          note: string | null
          reason: Database["public"]["Enums"]["inventory_movement_reason"]
          reference_id: string | null
          variant_id: string | null
          variant_sku: string
        }
        Insert: {
          actor?: string | null
          balance_after: number
          created_at?: string
          delta: number
          id?: string
          note?: string | null
          reason: Database["public"]["Enums"]["inventory_movement_reason"]
          reference_id?: string | null
          variant_id?: string | null
          variant_sku: string
        }
        Update: {
          actor?: string | null
          balance_after?: number
          created_at?: string
          delta?: number
          id?: string
          note?: string | null
          reason?: Database["public"]["Enums"]["inventory_movement_reason"]
          reference_id?: string | null
          variant_id?: string | null
          variant_sku?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_movements_actor_fkey"
            columns: ["actor"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_movements_variant_id_fkey"
            columns: ["variant_id"]
            isOneToOne: false
            referencedRelation: "product_variants"
            referencedColumns: ["id"]
          },
        ]
      }
      order_items: {
        Row: {
          color: string
          created_at: string
          id: string
          image_url: string | null
          line_total: number
          order_id: string
          product_id: string | null
          product_name: string
          product_slug: string | null
          quantity: number
          size: string
          sku: string
          unit_price: number
          updated_at: string
          variant_id: string | null
        }
        Insert: {
          color: string
          created_at?: string
          id?: string
          image_url?: string | null
          line_total: number
          order_id: string
          product_id?: string | null
          product_name: string
          product_slug?: string | null
          quantity: number
          size: string
          sku: string
          unit_price: number
          updated_at?: string
          variant_id?: string | null
        }
        Update: {
          color?: string
          created_at?: string
          id?: string
          image_url?: string | null
          line_total?: number
          order_id?: string
          product_id?: string | null
          product_name?: string
          product_slug?: string | null
          quantity?: number
          size?: string
          sku?: string
          unit_price?: number
          updated_at?: string
          variant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "order_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_variant_id_fkey"
            columns: ["variant_id"]
            isOneToOne: false
            referencedRelation: "product_variants"
            referencedColumns: ["id"]
          },
        ]
      }
      order_status_history: {
        Row: {
          changed_by: string | null
          created_at: string
          id: string
          note: string | null
          order_id: string
          status: Database["public"]["Enums"]["order_status"]
        }
        Insert: {
          changed_by?: string | null
          created_at?: string
          id?: string
          note?: string | null
          order_id: string
          status: Database["public"]["Enums"]["order_status"]
        }
        Update: {
          changed_by?: string | null
          created_at?: string
          id?: string
          note?: string | null
          order_id?: string
          status?: Database["public"]["Enums"]["order_status"]
        }
        Relationships: [
          {
            foreignKeyName: "order_status_history_changed_by_fkey"
            columns: ["changed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_status_history_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          advance_amount: number
          balance_due_on_delivery: number
          cart_id: string | null
          cash_collected_at: string | null
          cash_collected_by: string | null
          cod_handling_fee: number
          contact_email: string | null
          contact_phone: string | null
          coupon_code: string | null
          created_at: string
          customer_note: string | null
          delivered_at: string | null
          discount_total: number
          grand_total: number
          guest_token: string | null
          id: string
          order_number: string
          payment_method: string
          payment_reference: string | null
          payment_status: Database["public"]["Enums"]["payment_status"]
          placed_at: string
          quote_source: string | null
          quote_taken_at: string | null
          quoted_cod_fee_paise: number | null
          quoted_courier_id: number | null
          quoted_courier_name: string | null
          quoted_forward_paise: number | null
          quoted_rto_paise: number | null
          rto_actual_charge_paise: number | null
          rto_at: string | null
          rto_condition: string | null
          rto_received_at: string | null
          rto_received_by: string | null
          rto_restocked_at: string | null
          shipping_address: Json
          shipping_fee: number
          status: Database["public"]["Enums"]["order_status"]
          stock_restored_at: string | null
          subtotal: number
          tax_total: number
          updated_at: string
          user_id: string | null
        }
        Insert: {
          advance_amount?: number
          balance_due_on_delivery?: number
          cart_id?: string | null
          cash_collected_at?: string | null
          cash_collected_by?: string | null
          cod_handling_fee?: number
          contact_email?: string | null
          contact_phone?: string | null
          coupon_code?: string | null
          created_at?: string
          customer_note?: string | null
          delivered_at?: string | null
          discount_total?: number
          grand_total: number
          guest_token?: string | null
          id?: string
          order_number?: string
          payment_method?: string
          payment_reference?: string | null
          payment_status?: Database["public"]["Enums"]["payment_status"]
          placed_at?: string
          quote_source?: string | null
          quote_taken_at?: string | null
          quoted_cod_fee_paise?: number | null
          quoted_courier_id?: number | null
          quoted_courier_name?: string | null
          quoted_forward_paise?: number | null
          quoted_rto_paise?: number | null
          rto_actual_charge_paise?: number | null
          rto_at?: string | null
          rto_condition?: string | null
          rto_received_at?: string | null
          rto_received_by?: string | null
          rto_restocked_at?: string | null
          shipping_address: Json
          shipping_fee?: number
          status?: Database["public"]["Enums"]["order_status"]
          stock_restored_at?: string | null
          subtotal: number
          tax_total?: number
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          advance_amount?: number
          balance_due_on_delivery?: number
          cart_id?: string | null
          cash_collected_at?: string | null
          cash_collected_by?: string | null
          cod_handling_fee?: number
          contact_email?: string | null
          contact_phone?: string | null
          coupon_code?: string | null
          created_at?: string
          customer_note?: string | null
          delivered_at?: string | null
          discount_total?: number
          grand_total?: number
          guest_token?: string | null
          id?: string
          order_number?: string
          payment_method?: string
          payment_reference?: string | null
          payment_status?: Database["public"]["Enums"]["payment_status"]
          placed_at?: string
          quote_source?: string | null
          quote_taken_at?: string | null
          quoted_cod_fee_paise?: number | null
          quoted_courier_id?: number | null
          quoted_courier_name?: string | null
          quoted_forward_paise?: number | null
          quoted_rto_paise?: number | null
          rto_actual_charge_paise?: number | null
          rto_at?: string | null
          rto_condition?: string | null
          rto_received_at?: string | null
          rto_received_by?: string | null
          rto_restocked_at?: string | null
          shipping_address?: Json
          shipping_fee?: number
          status?: Database["public"]["Enums"]["order_status"]
          stock_restored_at?: string | null
          subtotal?: number
          tax_total?: number
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "orders_cart_id_fkey"
            columns: ["cart_id"]
            isOneToOne: false
            referencedRelation: "carts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_rto_received_by_fkey"
            columns: ["rto_received_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      pages: {
        Row: {
          body: string | null
          created_at: string
          id: string
          is_published: boolean
          meta_description: string | null
          meta_title: string | null
          slug: string
          title: string
          updated_at: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          id?: string
          is_published?: boolean
          meta_description?: string | null
          meta_title?: string | null
          slug: string
          title: string
          updated_at?: string
        }
        Update: {
          body?: string | null
          created_at?: string
          id?: string
          is_published?: boolean
          meta_description?: string | null
          meta_title?: string | null
          slug?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      payment_events: {
        Row: {
          event_id: string
          event_type: string
          id: string
          order_id: string | null
          processed_at: string | null
          provider: Database["public"]["Enums"]["payment_provider"]
          received_at: string
          result: string | null
        }
        Insert: {
          event_id: string
          event_type: string
          id?: string
          order_id?: string | null
          processed_at?: string | null
          provider: Database["public"]["Enums"]["payment_provider"]
          received_at?: string
          result?: string | null
        }
        Update: {
          event_id?: string
          event_type?: string
          id?: string
          order_id?: string | null
          processed_at?: string | null
          provider?: Database["public"]["Enums"]["payment_provider"]
          received_at?: string
          result?: string | null
        }
        Relationships: []
      }
      payments: {
        Row: {
          amount: number
          created_at: string
          currency: string
          id: string
          order_id: string
          provider: Database["public"]["Enums"]["payment_provider"]
          provider_order_id: string | null
          provider_payment_id: string | null
          raw_status: string | null
          status: Database["public"]["Enums"]["payment_txn_status"]
          updated_at: string
        }
        Insert: {
          amount: number
          created_at?: string
          currency?: string
          id?: string
          order_id: string
          provider: Database["public"]["Enums"]["payment_provider"]
          provider_order_id?: string | null
          provider_payment_id?: string | null
          raw_status?: string | null
          status?: Database["public"]["Enums"]["payment_txn_status"]
          updated_at?: string
        }
        Update: {
          amount?: number
          created_at?: string
          currency?: string
          id?: string
          order_id?: string
          provider?: Database["public"]["Enums"]["payment_provider"]
          provider_order_id?: string | null
          provider_payment_id?: string | null
          raw_status?: string | null
          status?: Database["public"]["Enums"]["payment_txn_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      product_images: {
        Row: {
          alt_text: string | null
          color: string | null
          created_at: string
          id: string
          is_primary: boolean
          product_id: string
          sort_order: number
          updated_at: string
          url: string
        }
        Insert: {
          alt_text?: string | null
          color?: string | null
          created_at?: string
          id?: string
          is_primary?: boolean
          product_id: string
          sort_order?: number
          updated_at?: string
          url: string
        }
        Update: {
          alt_text?: string | null
          color?: string | null
          created_at?: string
          id?: string
          is_primary?: boolean
          product_id?: string
          sort_order?: number
          updated_at?: string
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_images_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      product_variants: {
        Row: {
          color: string
          color_family: string | null
          color_hex: string | null
          created_at: string
          id: string
          is_active: boolean
          price_override: number | null
          product_id: string
          size: string
          sku: string
          stock_quantity: number
          updated_at: string
        }
        Insert: {
          color: string
          color_family?: string | null
          color_hex?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          price_override?: number | null
          product_id: string
          size: string
          sku: string
          stock_quantity?: number
          updated_at?: string
        }
        Update: {
          color?: string
          color_family?: string | null
          color_hex?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          price_override?: number | null
          product_id?: string
          size?: string
          sku?: string
          stock_quantity?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_variants_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      products: {
        Row: {
          base_price: number
          brand_id: string | null
          breadth_cm: number | null
          category_id: string | null
          created_at: string
          deleted_at: string | null
          description: string | null
          effective_price: number | null
          footwear_type: Database["public"]["Enums"]["footwear_type"]
          gender: Database["public"]["Enums"]["gender_group"]
          height_cm: number | null
          id: string
          is_active: boolean
          is_featured: boolean
          length_cm: number | null
          material: string | null
          meta_description: string | null
          meta_title: string | null
          name: string
          sale_price: number | null
          search_keywords: string[]
          slug: string
          updated_at: string
          weight_grams: number | null
        }
        Insert: {
          base_price: number
          brand_id?: string | null
          breadth_cm?: number | null
          category_id?: string | null
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          effective_price?: number | null
          footwear_type: Database["public"]["Enums"]["footwear_type"]
          gender?: Database["public"]["Enums"]["gender_group"]
          height_cm?: number | null
          id?: string
          is_active?: boolean
          is_featured?: boolean
          length_cm?: number | null
          material?: string | null
          meta_description?: string | null
          meta_title?: string | null
          name: string
          sale_price?: number | null
          search_keywords?: string[]
          slug: string
          updated_at?: string
          weight_grams?: number | null
        }
        Update: {
          base_price?: number
          brand_id?: string | null
          breadth_cm?: number | null
          category_id?: string | null
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          effective_price?: number | null
          footwear_type?: Database["public"]["Enums"]["footwear_type"]
          gender?: Database["public"]["Enums"]["gender_group"]
          height_cm?: number | null
          id?: string
          is_active?: boolean
          is_featured?: boolean
          length_cm?: number | null
          material?: string | null
          meta_description?: string | null
          meta_title?: string | null
          name?: string
          sale_price?: number | null
          search_keywords?: string[]
          slug?: string
          updated_at?: string
          weight_grams?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "products_brand_id_fkey"
            columns: ["brand_id"]
            isOneToOne: false
            referencedRelation: "brands"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "products_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          cod_blocked_at: string | null
          cod_blocked_reason: string | null
          created_at: string
          full_name: string | null
          id: string
          phone: string | null
          role: Database["public"]["Enums"]["user_role"]
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          cod_blocked_at?: string | null
          cod_blocked_reason?: string | null
          created_at?: string
          full_name?: string | null
          id: string
          phone?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          cod_blocked_at?: string | null
          cod_blocked_reason?: string | null
          created_at?: string
          full_name?: string | null
          id?: string
          phone?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
        }
        Relationships: []
      }
      rate_limits: {
        Row: {
          bucket: string
          count: number
          window_start: string
        }
        Insert: {
          bucket: string
          count?: number
          window_start?: string
        }
        Update: {
          bucket?: string
          count?: number
          window_start?: string
        }
        Relationships: []
      }
      refunds: {
        Row: {
          amount_paise: number
          created_at: string
          deduction_breakdown: Json
          failure_reason: string | null
          id: string
          initiated_by: string | null
          note: string | null
          order_id: string
          payment_id: string | null
          processed_at: string | null
          provider: Database["public"]["Enums"]["payment_provider"]
          razorpay_refund_id: string | null
          reason: Database["public"]["Enums"]["refund_reason"]
          status: Database["public"]["Enums"]["refund_status"]
          updated_at: string
        }
        Insert: {
          amount_paise: number
          created_at?: string
          deduction_breakdown?: Json
          failure_reason?: string | null
          id?: string
          initiated_by?: string | null
          note?: string | null
          order_id: string
          payment_id?: string | null
          processed_at?: string | null
          provider?: Database["public"]["Enums"]["payment_provider"]
          razorpay_refund_id?: string | null
          reason: Database["public"]["Enums"]["refund_reason"]
          status?: Database["public"]["Enums"]["refund_status"]
          updated_at?: string
        }
        Update: {
          amount_paise?: number
          created_at?: string
          deduction_breakdown?: Json
          failure_reason?: string | null
          id?: string
          initiated_by?: string | null
          note?: string | null
          order_id?: string
          payment_id?: string | null
          processed_at?: string | null
          provider?: Database["public"]["Enums"]["payment_provider"]
          razorpay_refund_id?: string | null
          reason?: Database["public"]["Enums"]["refund_reason"]
          status?: Database["public"]["Enums"]["refund_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "refunds_initiated_by_fkey"
            columns: ["initiated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "refunds_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "refunds_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
        ]
      }
      reviews: {
        Row: {
          body: string | null
          created_at: string
          id: string
          is_approved: boolean
          is_verified_purchase: boolean
          product_id: string
          rating: number
          title: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          id?: string
          is_approved?: boolean
          is_verified_purchase?: boolean
          product_id: string
          rating: number
          title?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          body?: string | null
          created_at?: string
          id?: string
          is_approved?: boolean
          is_verified_purchase?: boolean
          product_id?: string
          rating?: number
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reviews_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reviews_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      shipment_events: {
        Row: {
          created_at: string
          event_id: string
          event_type: string
          id: string
          payload: Json | null
          shipment_id: string
        }
        Insert: {
          created_at?: string
          event_id: string
          event_type: string
          id?: string
          payload?: Json | null
          shipment_id: string
        }
        Update: {
          created_at?: string
          event_id?: string
          event_type?: string
          id?: string
          payload?: Json | null
          shipment_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shipment_events_shipment_id_fkey"
            columns: ["shipment_id"]
            isOneToOne: false
            referencedRelation: "shipments"
            referencedColumns: ["id"]
          },
        ]
      }
      shipments: {
        Row: {
          awb_code: string | null
          cod_collectable_amount: number
          courier_id: string | null
          courier_name: string | null
          created_at: string
          delivered_at: string | null
          id: string
          invoice_url: string | null
          label_url: string | null
          manifest_url: string | null
          order_id: string
          pickup_scheduled_at: string | null
          pickup_token: string | null
          raw_awb: Json | null
          raw_order: Json | null
          raw_pickup: Json | null
          raw_tracking: Json | null
          rto_at: string | null
          rto_charge_paise: number | null
          shipment_id: string | null
          shiprocket_order_id: string | null
          status: string
          tracked_at: string | null
          updated_at: string
        }
        Insert: {
          awb_code?: string | null
          cod_collectable_amount?: number
          courier_id?: string | null
          courier_name?: string | null
          created_at?: string
          delivered_at?: string | null
          id?: string
          invoice_url?: string | null
          label_url?: string | null
          manifest_url?: string | null
          order_id: string
          pickup_scheduled_at?: string | null
          pickup_token?: string | null
          raw_awb?: Json | null
          raw_order?: Json | null
          raw_pickup?: Json | null
          raw_tracking?: Json | null
          rto_at?: string | null
          rto_charge_paise?: number | null
          shipment_id?: string | null
          shiprocket_order_id?: string | null
          status?: string
          tracked_at?: string | null
          updated_at?: string
        }
        Update: {
          awb_code?: string | null
          cod_collectable_amount?: number
          courier_id?: string | null
          courier_name?: string | null
          created_at?: string
          delivered_at?: string | null
          id?: string
          invoice_url?: string | null
          label_url?: string | null
          manifest_url?: string | null
          order_id?: string
          pickup_scheduled_at?: string | null
          pickup_token?: string | null
          raw_awb?: Json | null
          raw_order?: Json | null
          raw_pickup?: Json | null
          raw_tracking?: Json | null
          rto_at?: string | null
          rto_charge_paise?: number | null
          shipment_id?: string | null
          shiprocket_order_id?: string | null
          status?: string
          tracked_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "shipments_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: true
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      shipping_quotes: {
        Row: {
          advance_paise: number | null
          cart_id: string
          cod_available: boolean
          cod_fee_paise: number | null
          cod_handling_paise: number
          cost_forward_paise: number | null
          cost_rto_paise: number | null
          courier_id: number | null
          courier_name: string | null
          deliverable: boolean
          estimated_days: number | null
          fee_paise: number
          freight_paise: number | null
          id: string
          payment_method: string
          postal_code: string
          quoted_at: string
          shipping_fee_paise: number
          source: string
          subtotal_paise: number
        }
        Insert: {
          advance_paise?: number | null
          cart_id: string
          cod_available: boolean
          cod_fee_paise?: number | null
          cod_handling_paise?: number
          cost_forward_paise?: number | null
          cost_rto_paise?: number | null
          courier_id?: number | null
          courier_name?: string | null
          deliverable: boolean
          estimated_days?: number | null
          fee_paise: number
          freight_paise?: number | null
          id?: string
          payment_method: string
          postal_code: string
          quoted_at?: string
          shipping_fee_paise?: number
          source: string
          subtotal_paise: number
        }
        Update: {
          advance_paise?: number | null
          cart_id?: string
          cod_available?: boolean
          cod_fee_paise?: number | null
          cod_handling_paise?: number
          cost_forward_paise?: number | null
          cost_rto_paise?: number | null
          courier_id?: number | null
          courier_name?: string | null
          deliverable?: boolean
          estimated_days?: number | null
          fee_paise?: number
          freight_paise?: number | null
          id?: string
          payment_method?: string
          postal_code?: string
          quoted_at?: string
          shipping_fee_paise?: number
          source?: string
          subtotal_paise?: number
        }
        Relationships: [
          {
            foreignKeyName: "shipping_quotes_cart_id_fkey"
            columns: ["cart_id"]
            isOneToOne: false
            referencedRelation: "carts"
            referencedColumns: ["id"]
          },
        ]
      }
      site_settings: {
        Row: {
          created_at: string
          description: string | null
          is_public: boolean
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          created_at?: string
          description?: string | null
          is_public?: boolean
          key: string
          updated_at?: string
          value: Json
        }
        Update: {
          created_at?: string
          description?: string | null
          is_public?: boolean
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      wishlist_items: {
        Row: {
          created_at: string
          id: string
          product_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          product_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          product_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "wishlist_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wishlist_items_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      adjust_variant_stock: {
        Args: {
          p_delta: number
          p_note: string
          p_reason: Database["public"]["Enums"]["inventory_movement_reason"]
          p_variant_id: string
        }
        Returns: number
      }
      admin_delete_product: { Args: { p_product_id: string }; Returns: string }
      adopt_guest_orders: { Args: never; Returns: number }
      assert_cart_stock: { Args: { p_cart_id: string }; Returns: undefined }
      can_access_cart: { Args: { cart: string }; Returns: boolean }
      cancel_order_with_restock: {
        Args: {
          p_changed_by?: string
          p_movement_reason?: Database["public"]["Enums"]["inventory_movement_reason"]
          p_order_id: string
          p_reason: string
          p_release_cart?: boolean
          p_require_unpaid?: boolean
        }
        Returns: string
      }
      catalog_query: {
        Args: {
          p_brands?: string[]
          p_category_slug?: string
          p_collection_slug?: string
          p_colors?: string[]
          p_gender?: Database["public"]["Enums"]["gender_group"]
          p_in_stock?: boolean
          p_limit?: number
          p_max_price?: number
          p_min_price?: number
          p_offset?: number
          p_on_sale?: boolean
          p_search?: string
          p_sizes?: string[]
          p_sort?: string
          p_type?: Database["public"]["Enums"]["footwear_type"]
        }
        Returns: Json
      }
      color_family: { Args: { hex: string }; Returns: string }
      consume_rate_limit: {
        Args: { p_bucket: string; p_limit: number; p_window_seconds: number }
        Returns: {
          allowed: boolean
          remaining: number
          retry_after_seconds: number
        }[]
      }
      create_order_with_stock: {
        Args: {
          p_advance_amount?: number
          p_cart_id: string
          p_cod_handling_fee?: number
          p_contact_email?: string
          p_contact_phone?: string
          p_customer_note?: string
          p_discount_total?: number
          p_free_shipping_above?: number
          p_guest_token?: string
          p_initial_status: Database["public"]["Enums"]["order_status"]
          p_payment_method: string
          p_payment_status: Database["public"]["Enums"]["payment_status"]
          p_quote_source?: string
          p_quoted_cod_fee_paise?: number
          p_quoted_courier_id?: number
          p_quoted_courier_name?: string
          p_quoted_forward_paise?: number
          p_quoted_rto_paise?: number
          p_shipping_address: Json
          p_shipping_flat_fee: number
          p_user_id?: string
        }
        Returns: {
          advance_amount: number
          balance_due: number
          grand_total: number
          item_count: number
          order_id: string
          order_number: string
          shipping_fee: number
          subtotal: number
        }[]
      }
      current_guest_token: { Args: never; Returns: string }
      discontinued_product_hint: {
        Args: { p_slug: string }
        Returns: {
          category_name: string
          category_slug: string
          name: string
        }[]
      }
      is_admin: { Args: never; Returns: boolean }
      merge_guest_cart: {
        Args: { p_guest_token: string; p_max_line_quantity: number }
        Returns: {
          dropped: number
          guest_cart_consumed: boolean
          merged: number
        }[]
      }
      next_order_number: { Args: never; Returns: string }
      owns_order: { Args: { order_ref: string }; Returns: boolean }
      product_is_live: { Args: { product_ref: string }; Returns: boolean }
      reconcile_inventory: {
        Args: never
        Returns: {
          drift: number
          ledger_total: number
          sku: string
          stock_quantity: number
          unspecified_rows: number
          variant_id: string
        }[]
      }
      release_abandoned_orders: {
        Args: { p_older_than_minutes?: number }
        Returns: number
      }
    }
    Enums: {
      cart_status: "active" | "converted" | "abandoned"
      coupon_type: "percent" | "fixed"
      footwear_type:
        | "sneaker"
        | "formal"
        | "sandal"
        | "slide"
        | "boot"
        | "sports"
        | "flipflop"
      gender_group: "men" | "women" | "unisex" | "kids"
      inventory_movement_reason:
        | "opening_balance"
        | "order"
        | "cancellation"
        | "sweep"
        | "admin_adjustment"
        | "restock"
        | "shipment"
        | "unspecified"
        | "replacement"
        | "rto_return"
        | "rto_writeoff"
      order_status:
        | "pending"
        | "confirmed"
        | "packed"
        | "shipped"
        | "delivered"
        | "cancelled"
        | "returning"
        | "returned"
      payment_provider: "cod" | "razorpay"
      payment_status: "unpaid" | "paid" | "refunded"
      payment_txn_status:
        | "created"
        | "pending"
        | "captured"
        | "failed"
        | "refunded"
      refund_reason:
        | "cancelled_before_dispatch"
        | "rto"
        | "shop_error"
        | "other"
      refund_status: "created" | "pending" | "processed" | "failed"
      section_type:
        | "hero"
        | "category_grid"
        | "product_rail"
        | "banner"
        | "promo_strip"
        | "testimonials"
        | "rich_text"
      user_role: "customer" | "staff" | "admin"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      cart_status: ["active", "converted", "abandoned"],
      coupon_type: ["percent", "fixed"],
      footwear_type: [
        "sneaker",
        "formal",
        "sandal",
        "slide",
        "boot",
        "sports",
        "flipflop",
      ],
      gender_group: ["men", "women", "unisex", "kids"],
      inventory_movement_reason: [
        "opening_balance",
        "order",
        "cancellation",
        "sweep",
        "admin_adjustment",
        "restock",
        "shipment",
        "unspecified",
        "replacement",
        "rto_return",
        "rto_writeoff",
      ],
      order_status: [
        "pending",
        "confirmed",
        "packed",
        "shipped",
        "delivered",
        "cancelled",
        "returning",
        "returned",
      ],
      payment_provider: ["cod", "razorpay"],
      payment_status: ["unpaid", "paid", "refunded"],
      payment_txn_status: [
        "created",
        "pending",
        "captured",
        "failed",
        "refunded",
      ],
      refund_reason: [
        "cancelled_before_dispatch",
        "rto",
        "shop_error",
        "other",
      ],
      refund_status: ["created", "pending", "processed", "failed"],
      section_type: [
        "hero",
        "category_grid",
        "product_rail",
        "banner",
        "promo_strip",
        "testimonials",
        "rich_text",
      ],
      user_role: ["customer", "staff", "admin"],
    },
  },
} as const
