'use strict';
/**
 * AUBE — Feature : Avis clients vérifiés avec photos
 */
const multer = require('multer');

module.exports = {
  register(ctx) {
    const { app, store, storage, HttpError, asyncHandler, requireAdmin, requireCustomer, helpers } = ctx;

    // Configuration de Multer pour la photo de l'avis
    const upload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: 8 * 1024 * 1024 }, // 8 Mo max
      fileFilter: (req, file, cb) => {
        if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) cb(null, true);
        else cb(new HttpError(400, 'Format de photo non accepté (JPG, PNG ou WebP).'));
      }
    });

    // ----- PUBLIC : Récupérer les avis validés d'un produit -----
    app.get('/api/products/:id/reviews', asyncHandler(async (req, res) => {
      const productId = ctx.validate.parseId(req.params.id);
      const data = await store.load();
      
      const productReviews = (data.reviews || [])
        .filter(r => r.productId === productId && r.status === 'approved')
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      // Calcul de la note moyenne
      const totalRating = productReviews.reduce((sum, r) => sum + r.rating, 0);
      const averageRating = productReviews.length > 0 ? (totalRating / productReviews.length).toFixed(1) : null;

      res.json({
        averageRating: averageRating ? parseFloat(averageRating) : 0,
        totalReviews: productReviews.length,
        reviews: productReviews.map(r => ({
          id: r.id,
          rating: r.rating,
          comment: r.comment,
          authorName: r.authorName,
          imageUrl: r.imageUrl || null,
          createdAt: r.createdAt
        }))
      });
    }));

    // ----- CLIENTE : Déposer un avis vérifié -----
    app.post('/api/products/:id/reviews', requireCustomer, upload.single('image'), asyncHandler(async (req, res) => {
      const productId = ctx.validate.parseId(req.params.id);
      const customerId = req.session.customerId;
      const rating = ctx.validate.intInRange(req.body.rating, 1, 5, 0);
      const comment = ctx.validate.cleanText(req.body.comment, 1000);

      if (rating < 1 || rating > 5) throw new HttpError(400, 'La note doit être comprise entre 1 et 5 étoiles.');
      if (!comment || comment.length < 5) throw new HttpError(400, 'Ton commentaire doit faire au moins 5 caractères.');

      const data = await store.load();

      // 1. Vérification : La cliente a-t-elle vraiment acheté et reçu ce produit ?
      const verifiedPurchase = (data.orders || []).some(order => 
        order.customerId === customerId &&
        order.status === 'paid' &&
        (order.items || []).some(item => item.productId === productId)
      );

      if (!verifiedPurchase) {
        throw new HttpError(403, 'Avis réservé aux clientes ayant déjà acheté ce produit.');
      }

      // 2. Traitement de la photo portée (si présente)
      let imageUrl = null;
      if (req.file) {
        const baseName = `review-${Date.now()}-${ctx.secureToken(8)}`;
        if (storage.USE_SUPABASE_STORAGE) {
          imageUrl = await storage.uploadToSupabase(req.file.buffer, `${baseName}.jpg`);
        } else {
          // Traitement local ou Sharp si disponible
          imageUrl = await ctx.helpers.saveProcessedImage ? ctx.helpers.saveProcessedImage(req.file.buffer) : null;
        }
      }

      const customer = data.customers.find(c => c.id === customerId);

      // 3. Enregistrement de l'avis (statut 'pending' par défaut pour modération patron)
      const review = await store.withTransaction(async (dbData) => {
        dbData.reviews = dbData.reviews || [];
        dbData.nextReviewId = dbData.nextReviewId || 1;

        const newReview = {
          id: dbData.nextReviewId++,
          productId,
          customerId,
          authorName: customer ? customer.name.split(' ')[0] : 'Cliente Aube', // Affiche juste le prénom pour la confidentialité
          rating,
          comment,
          imageUrl,
          status: 'pending', // En attente de validation par le patron
          createdAt: new Date().toISOString()
        };

        dbData.reviews.push(newReview);
        return newReview;
      });

      ctx.helpers.audit('review.submitted', req, { productId, reviewId: review.id });

      res.status(201).json({
        ok: true,
        message: 'Merci pour ton avis ! Il sera publié dès sa validation par notre équipe.'
      });
    }));

    // ----- PATRON : Lister tous les avis pour modération -----
    app.get('/api/admin/reviews', requireAdmin, asyncHandler(async (req, res) => {
      const data = await store.load();
      const reviews = (data.reviews || []).map(r => {
        const product = (data.products || []).find(p => p.id === r.productId);
        return {
          ...r,
          productName: product ? product.name : `Produit #${r.productId}`
        };
      }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      res.json(reviews);
    }));

    // ----- PATRON : Valider ou rejeter un avis -----
    app.patch('/api/admin/reviews/:id', requireAdmin, asyncHandler(async (req, res) => {
      const reviewId = ctx.validate.parseId(req.params.id);
      const { status } = req.body || {};

      if (!['approved', 'rejected'].includes(status)) {
        throw new HttpError(400, 'Statut invalide (approved ou rejected).');
      }

      await store.withTransaction(async (dbData) => {
        const r = (dbData.reviews || []).find(x => x.id === reviewId);
        if (!r) throw new HttpError(404, 'Avis introuvable.');
        r.status = status;
      });

      ctx.helpers.audit('review.moderated', req, { reviewId, status });
      res.json({ ok: true });
    }));

    // Exposer l'option dans l'API de config publique
    ctx.publicConfig.add(async () => ({
      reviewsEnabled: true
    }));

    console.log('✅ Option "Avis clients vérifiés" activée.');
  }
};
