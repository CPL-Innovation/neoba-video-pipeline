"""Tier 3: Semantic Clustering using TF-IDF + UMAP + HDBSCAN."""

import json
from pathlib import Path

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
SOURCE_FILE = BASE_DIR / "public" / "data" / "source" / "items.json"


def load_descriptions() -> tuple[list[str], list[str]]:
    """Load item descriptions and IDs."""
    with open(SOURCE_FILE) as f:
        items = json.load(f)
    item_ids = [f"{item['container']}-{item['item']}" for item in items]
    descriptions = [item["description"] for item in items]
    return item_ids, descriptions


def run_clustering(run_name: str) -> dict:
    """Run Tier 3 clustering pipeline."""
    # Lazy imports for heavy deps
    import umap
    import hdbscan

    run_dir = DATA_DIR / "runs" / "catalog" / run_name
    run_dir.mkdir(parents=True, exist_ok=True)

    item_ids, descriptions = load_descriptions()

    # TF-IDF vectorization
    # Word n-grams (1,2) + character n-grams (2,5) combined
    word_vectorizer = TfidfVectorizer(
        analyzer="word",
        ngram_range=(1, 2),
        min_df=3,
        max_df=0.5,
        max_features=5000,
    )
    char_vectorizer = TfidfVectorizer(
        analyzer="char_wb",
        ngram_range=(2, 5),
        min_df=3,
        max_df=0.5,
        max_features=5000,
    )

    word_matrix = word_vectorizer.fit_transform(descriptions)
    char_matrix = char_vectorizer.fit_transform(descriptions)

    from scipy.sparse import hstack
    tfidf_matrix = hstack([word_matrix, char_matrix])

    # UMAP for clustering (15D)
    umap_15d = umap.UMAP(
        n_neighbors=15,
        min_dist=0.1,
        n_components=15,
        random_state=42,
        metric="cosine",
    )
    embedding_15d = umap_15d.fit_transform(tfidf_matrix.toarray())

    # UMAP for visualization (2D)
    umap_2d = umap.UMAP(
        n_neighbors=15,
        min_dist=0.1,
        n_components=2,
        random_state=42,
        metric="cosine",
    )
    embedding_2d = umap_2d.fit_transform(tfidf_matrix.toarray())

    # HDBSCAN clustering on 15D embeddings
    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=20,
        min_samples=5,
        cluster_selection_epsilon=0.0,
    )
    cluster_labels = clusterer.fit_predict(embedding_15d)

    # Build cluster metadata
    unique_clusters = set(cluster_labels)
    unique_clusters.discard(-1)

    # Load classifications for thread overlap (if available)
    classifications_file = run_dir / "classifications.json"
    classifications = {}
    if classifications_file.exists():
        with open(classifications_file) as f:
            cls_list = json.load(f)
        classifications = {c["item_id"]: c for c in cls_list}

    # Get feature names for term extraction
    word_features = word_vectorizer.get_feature_names_out()

    clusters = []
    for cid in sorted(unique_clusters):
        mask = cluster_labels == cid
        indices = np.where(mask)[0]

        # Top TF-IDF terms
        cluster_tfidf = word_matrix[indices].mean(axis=0).A1
        top_term_indices = cluster_tfidf.argsort()[-10:][::-1]
        top_terms = [word_features[i] for i in top_term_indices if cluster_tfidf[i] > 0]

        # Sample descriptions
        sample_indices = indices[:10]
        samples = [descriptions[i] for i in sample_indices]

        # Temporal distribution
        with open(SOURCE_FILE) as f:
            all_items = json.load(f)
        temporal = {}
        for idx in indices:
            year = all_items[idx].get("year")
            if year:
                temporal[str(year)] = temporal.get(str(year), 0) + 1

        # Thread overlap
        thread_counts: dict[str, int] = {}
        for idx in indices:
            iid = item_ids[idx]
            if iid in classifications:
                for t in classifications[iid].get("threads", []):
                    thread_counts[t["name"]] = thread_counts.get(t["name"], 0) + 1

        clusters.append({
            "cluster_id": int(cid),
            "top_terms": top_terms[:10],
            "sample_descriptions": samples,
            "item_count": int(mask.sum()),
            "temporal_distribution": temporal,
            "thread_overlap": thread_counts,
        })

    # Build output
    points = []
    for i, (iid, x, y, cid) in enumerate(
        zip(item_ids, embedding_2d[:, 0], embedding_2d[:, 1], cluster_labels)
    ):
        points.append({
            "item_id": iid,
            "x": float(x),
            "y": float(y),
            "cluster_id": int(cid),
        })

    result = {
        "points": points,
        "clusters": clusters,
    }

    with open(run_dir / "clusters.json", "w") as f:
        json.dump(result, f)

    return result


if __name__ == "__main__":
    import sys
    import time

    run_name = sys.argv[1] if len(sys.argv) > 1 else time.strftime("%Y-%m-%d")
    print(f"Running clustering for run: {run_name}")
    result = run_clustering(run_name)
    print(f"Done: {len(result['clusters'])} clusters found, {len(result['points'])} points")
