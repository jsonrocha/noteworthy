import { supabase } from './supabase.js';

/* ── Users ── */
export async function upsertUser(profile) {
    const { error } = await supabase.from('users').upsert({
        id: profile.id,
        username: profile.username,
        display_name: profile.display_name,
        email: profile.email ?? null,
        avatar_url: profile.images?.[0]?.url ?? null,
    }, { onConflict: 'id' });
    if (error) console.error('upsertUser', error);
}

export async function getUser(id) {
    const { data } = await supabase.from('users').select('*').eq('id', id).single();
    return data;
}

export async function getAllUsers() {
    const { data } = await supabase.from('users').select('*');
    return data ?? [];
}

export async function searchUsers(query, excludeId) {
    const { data, error } = await supabase
        .from('users')
        .select('*')
        .or(`display_name.ilike.%${query}%,id.ilike.%${query}%`)
        .neq('id', excludeId)
        .limit(20);
    if (error) console.error('searchUsers', error);
    return data ?? [];
}

/* ── Follows ── */
export async function getFollowing(userId) {
    const { data } = await supabase.from('follows').select('following_id').eq('follower_id', userId);
    return data?.map(r => r.following_id) ?? [];
}

export async function getFollowers(userId) {
    const { data } = await supabase.from('follows').select('follower_id').eq('following_id', userId);
    return data?.map(r => r.follower_id) ?? [];
}

export async function follow(followerId, followingId) {
    const { error } = await supabase.from('follows').insert({ follower_id: followerId, following_id: followingId });
    if (error) console.error('follow', error);
}

export async function unfollow(followerId, followingId) {
    const { error } = await supabase.from('follows').delete()
        .eq('follower_id', followerId).eq('following_id', followingId);
    if (error) console.error('unfollow', error);
}

/* ── Reviews ── */
export async function getFeedReviews(userId, followingIds) {
    const ids = [userId, ...followingIds];
    const { data, error } = await supabase.from('reviews').select(`
        *,
        likes(user_id),
        comments(id, user_id, body, created_at)
    `).in('user_id', ids).order('created_at', { ascending: false }).limit(50);
    if (error) console.error('getFeedReviews', error);
    return data ?? [];
}

export async function getAllReviews() {
    const { data, error } = await supabase.from('reviews').select(`
        *,
        likes(user_id),
        comments(id, user_id, body, created_at)
    `).order('created_at', { ascending: false }).limit(50);
    if (error) console.error('getAllReviews', error);
    return data ?? [];
}

export async function getUserReviews(userId) {
    const { data, error } = await supabase.from('reviews').select(`
        *,
        likes(user_id),
        comments(id, user_id, body, created_at)
    `).eq('user_id', userId).order('created_at', { ascending: false });
    if (error) console.error('getUserReviews', error);
    return data ?? [];
}

export async function insertReview(review) {
    const { data, error } = await supabase.from('reviews').insert({
        id: review.id,
        user_id: review.userId,
        item_id: review.item.id,
        item_type: review.item.type,
        item_title: review.item.title,
        item_artist: review.item.artist,
        item_cover: review.item.cover ?? null,
        item_year: review.item.year ?? null,
        item_preview_url: review.item.previewUrl ?? null,
        item_apple_url: review.item.appleUrl ?? null,
        stars: review.stars,
        body: review.text ?? null,
    }).select().single();
    if (error) console.error('insertReview', error);
    return data;
}

export async function updateReview(id, stars, body) {
    const { error } = await supabase.from('reviews').update({ stars, body }).eq('id', id);
    if (error) console.error('updateReview', error);
}

export async function deleteReview(id) {
    const { error } = await supabase.from('reviews').delete().eq('id', id);
    if (error) console.error('deleteReview', error);
}

/* ── Real-time feed subscription ──
   Listens for INSERT/UPDATE/DELETE on the reviews table for the
   current user and anyone they follow. Returns an unsubscribe fn.   */
export function subscribeToFeed(userId, followingIds, onChange) {
    const ids = new Set([userId, ...followingIds]);

    const channel = supabase
        .channel('feed-' + userId)
        .on('postgres_changes', {
            event: '*',
            schema: 'public',
            table: 'reviews',
        }, (payload) => {
            const row = payload.new ?? payload.old;
            // Only care about reviews from people we follow (or ourselves)
            if (!ids.has(row?.user_id)) return;
            onChange(payload.eventType, row);
        })
        .subscribe();

    return () => supabase.removeChannel(channel);
}

/* ── Likes ── */
export async function addLike(userId, reviewId) {
    const { error } = await supabase.from('likes').insert({ user_id: userId, review_id: reviewId });
    if (error) console.error('addLike', error);
}

export async function removeLike(userId, reviewId) {
    const { error } = await supabase.from('likes').delete()
        .eq('user_id', userId).eq('review_id', reviewId);
    if (error) console.error('removeLike', error);
}

/* ── Comments ── */
export async function addComment(comment) {
    const { data, error } = await supabase.from('comments').insert({
        id: comment.id,
        review_id: comment.reviewId,
        user_id: comment.userId,
        body: comment.text,
    }).select().single();
    if (error) console.error('addComment', error);
    return data;
}

export async function deleteComment(id) {
    const { error } = await supabase.from('comments').delete().eq('id', id);
    if (error) console.error('deleteComment', error);
}

/* ── Lists ── */
export async function getUserLists(userId) {
    const { data } = await supabase.from('lists').select(`
        *,
        list_items(*)
    `).eq('user_id', userId).order('created_at', { ascending: false });
    return data ?? [];
}

export async function getAllLists() {
    const { data } = await supabase.from('lists').select(`
        *,
        list_items(*)
    `).order('created_at', { ascending: false });
    return data ?? [];
}

export async function insertList(list) {
    const { data, error } = await supabase.from('lists').insert({
        id: list.id,
        user_id: list.userId,
        title: list.title,
        description: list.description ?? null,
    }).select().single();
    if (error) { console.error('insertList', error); return null; }

    if (list.items?.length) {
        const { error: itemsError } = await supabase.from('list_items').insert(
            list.items.map(item => ({
                id: item.id,
                list_id: list.id,
                rank: item.rank,
                item_title: item.title,
                item_artist: item.artist,
                item_type: item.type,
                item_cover: item.cover ?? null,
                item_id: item.id,
            }))
        );
        if (itemsError) console.error('insertList items', itemsError);
    }
    return data;
}

export async function updateList(list) {
    const { error } = await supabase.from('lists').update({
        title: list.title,
        description: list.description ?? null,
    }).eq('id', list.id);
    if (error) { console.error('updateList', error); return; }

    // Replace all items
    await supabase.from('list_items').delete().eq('list_id', list.id);
    if (list.items?.length) {
        const { error: itemsError } = await supabase.from('list_items').insert(
            list.items.map(item => ({
                id: item.id + '_' + list.id,
                list_id: list.id,
                rank: item.rank,
                item_title: item.title,
                item_artist: item.artist,
                item_type: item.type,
                item_cover: item.cover ?? null,
                item_id: item.id,
            }))
        );
        if (itemsError) console.error('updateList items', itemsError);
    }
}

export async function deleteList(id) {
    const { error } = await supabase.from('lists').delete().eq('id', id);
    if (error) console.error('deleteList', error);
}

/* ── Notifications ── */
export async function getNotifications(userId) {
    // Step 1: get the user's own review IDs + metadata
    const { data: myReviews } = await supabase
        .from('reviews').select('id, item_title, item_artist').eq('user_id', userId);
    if (!myReviews?.length) return [];

    const ids = myReviews.map(r => r.id);
    const reviewMeta = Object.fromEntries(myReviews.map(r => [r.id, { title: r.item_title, artist: r.item_artist }]));

    // Step 2: fetch comments + likes on those reviews (excluding own actions)
    const [{ data: comments }, { data: likes }] = await Promise.all([
        supabase.from('comments')
            .select('id, user_id, body, created_at, review_id')
            .in('review_id', ids).neq('user_id', userId)
            .order('created_at', { ascending: false }).limit(50),
        supabase.from('likes')
            .select('user_id, review_id, created_at')
            .in('review_id', ids).neq('user_id', userId)
            .order('created_at', { ascending: false }).limit(50),
    ]);

    return [
        ...(comments ?? []).map(c => ({
            type: 'comment', id: c.id, userId: c.user_id,
            reviewId: c.review_id, text: c.body, createdAt: c.created_at,
            itemTitle: reviewMeta[c.review_id]?.title ?? '',
            itemArtist: reviewMeta[c.review_id]?.artist ?? '',
        })),
        ...(likes ?? []).map(l => ({
            type: 'like', id: `like-${l.user_id}-${l.review_id}`,
            userId: l.user_id, reviewId: l.review_id, createdAt: l.created_at,
            itemTitle: reviewMeta[l.review_id]?.title ?? '',
            itemArtist: reviewMeta[l.review_id]?.artist ?? '',
        })),
    ].sort((a, b) => new Date(b.createdAt ?? 0) - new Date(a.createdAt ?? 0));
}

/* ── Profile updates ── */
export async function updateDisplayName(userId, displayName) {
    const { error } = await supabase.from('users').update({ display_name: displayName }).eq('id', userId);
    if (error) console.error('updateDisplayName', error);
}
